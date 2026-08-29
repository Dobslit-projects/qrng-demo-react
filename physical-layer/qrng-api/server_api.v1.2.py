#!/usr/bin/env python3
"""
QRNG Broker API — binary uint32-LE stream (v1.2)
Compatível com v1.0/v1.1 (todos os endpoints e o CORPO das respostas inalterados).
Mudanças v1.2 (2026-08-29 — itens 2/3/4/5/9):
  - Envelope de proveniência v1 em headers (X-QRNG-Provenance-Version=1, -Source-Instance,
    -Source-Status, -Received-At, -Entropy-Health, -Capture-Id, -Sequence, -Block-SHA256,
    -Byte-Count, -Transport-Format, -Buffer-Discontinuous, -Discontinuities, -Realign-Bytes).
  - X-QRNG-Received-At = last_push_time (instante em que o broker RECEBEU os bytes).
    NÃO é captura física. captured_at continua ausente (FPGA não carimba).
  - WordAligner (transport_align.py): só palavras completas entram no ring buffer;
    realinhamento do grid uint32 após reconexão do connector (sideband JSONL);
    contagem de descontinuidades (reconnect|realign|drop_oldest).
  - X-QRNG-Entropy-Health = not_assessed (RCT/APT não rodam aqui).
  - GET /v1/capture/{id} — consulta de metadata por capture_id (sem bytes).
O corpo binário/hex/uint32 é BYTE-IDÊNTICO ao v1.1.
"""
import os, time, threading, struct, hashlib, json as _json
from collections import OrderedDict
from datetime import datetime, timezone
from fastapi import FastAPI, Query, Response
from fastapi.responses import StreamingResponse, JSONResponse

try:
    from transport_align import WordAligner, parse_connector_events
except Exception:                                   # pragma: no cover
    WordAligner = None
    def parse_connector_events(_t):  # type: ignore
        return []

SOURCE_OFFLINE_THRESHOLD = 5.0
SOURCE_OFFLINE_LONG      = 60.0
POP_TIMEOUT              = 2.0

STREAM_FORMAT      = "uint32-le"
SAMPLE_WIDTH_BYTES = 4
CONDITIONED        = False

PROV_ENVELOPE_VERSION = "1"
SOURCE_INSTANCE       = os.environ.get("QRNG_SOURCE_INSTANCE", "dobslit-qrng-ufpe-fpga")
CONNECTOR_EVENTS      = os.environ.get("QRNG_CONNECTOR_EVENTS", "/tmp/qrng_connector_events.jsonl")
CAPTURE_LOG           = os.environ.get("QRNG_CAPTURE_LOG", "/home/dobslit/qrng-api/captures.jsonl")

_cap_reg  = OrderedDict()
_CAP_MAX  = 1024
_cap_lock = threading.Lock()

# ---------- FIFO tail reader (inalterado) ----------
class FileTailByteSource:
    def __init__(self, path: str, poll_s: float = 0.5):
        self.path   = path
        self.poll_s = poll_s
        self._fd    = None

    def open(self):
        while True:
            try:
                self._fd = open(self.path, "rb", buffering=0)
                return
            except (FileNotFoundError, OSError):
                time.sleep(self.poll_s)

    def read(self, n: int) -> bytes:
        while True:
            try:
                data = self._fd.read(n)
                if data:
                    return data
                self._close_fd()
                time.sleep(self.poll_s)
                self._reopen()
            except OSError:
                self._close_fd()
                time.sleep(self.poll_s)
                self._reopen()

    def _close_fd(self):
        try:
            self._fd.close()
        except Exception:
            pass

    def _reopen(self):
        while True:
            try:
                if not os.path.exists(self.path):
                    time.sleep(self.poll_s)
                    continue
                self._fd = open(self.path, "rb", buffering=0)
                return
            except (FileNotFoundError, OSError):
                time.sleep(self.poll_s)

# ---------- Ring buffer (inalterado + pop_with_prov) ----------
class RingBuffer:
    def __init__(self, capacity: int):
        self.buf            = bytearray(capacity)
        self.capacity       = capacity
        self.head           = self.tail = self.size = 0
        self.lock           = threading.Lock()
        self.not_empty      = threading.Condition(self.lock)
        self.total_pushed   = 0
        self.total_popped   = 0
        self.last_push_time  = 0.0

    def push(self, data: bytes):
        with self.lock:
            if len(data) > self.capacity:
                data = data[-self.capacity:]
            while self.size + len(data) > self.capacity:
                drop = min(self.size, (self.size + len(data)) - self.capacity)
                self.tail = (self.tail + drop) % self.capacity
                self.size -= drop
            first = min(len(data), self.capacity - self.head)
            self.buf[self.head:self.head + first] = data[:first]
            second = len(data) - first
            if second:
                self.buf[0:second] = data[first:]
            self.head = (self.head + len(data)) % self.capacity
            self.size += len(data)
            self.total_pushed += len(data)
            self.last_push_time = time.time()
            self.not_empty.notify_all()

    def pop(self, n: int) -> bytes:
        with self.not_empty:
            while self.size < n:
                self.not_empty.wait()
            return self._read_n(n)

    def pop_timeout(self, n: int, timeout: float):
        deadline = time.time() + timeout
        with self.not_empty:
            while self.size < n:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None
                self.not_empty.wait(timeout=remaining)
                if self.size >= n:
                    break
            if self.size < n:
                return None
            return self._read_n(n)

    def pop_with_prov(self, n: int, timeout: float):
        """Como pop_timeout, mas devolve (data, seq_before, discont_count, realign_bytes)."""
        deadline = time.time() + timeout
        with self.not_empty:
            seq_before = self.total_popped
            while self.size < n:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None, seq_before, _aligner_state()["discontinuities"], _aligner_state()["realign_bytes_total"]
                self.not_empty.wait(timeout=remaining)
                if self.size >= n:
                    break
            if self.size < n:
                return None, seq_before, _aligner_state()["discontinuities"], _aligner_state()["realign_bytes_total"]
            data = self._read_n(n)
        st = _aligner_state()
        return data, seq_before, st["discontinuities"], st["realign_bytes_total"]

    def _read_n(self, n: int) -> bytes:
        out = bytearray(n)
        first = min(n, self.capacity - self.tail)
        out[:first] = self.buf[self.tail:self.tail + first]
        second = n - first
        if second:
            out[first:] = self.buf[0:second]
        self.tail   = (self.tail + n) % self.capacity
        self.size   -= n
        self.total_popped += n
        return bytes(out)

    def source_status(self) -> str:
        if self.total_pushed == 0:
            return "offline"
        stall = time.time() - self.last_push_time
        if stall < SOURCE_OFFLINE_THRESHOLD:
            return "online"
        if stall < SOURCE_OFFLINE_LONG:
            return "degraded"
        return "offline"

# ---------- WordAligner (itens 2/3) ----------
_align_lock = threading.Lock()
_aligner = WordAligner() if WordAligner is not None else None

def _aligner_state() -> dict:
    if _aligner is None:
        return {"discontinuities": 0, "realign_bytes_total": 0, "stream_offset": 0}
    with _align_lock:
        try:
            return _aligner.state()
        except Exception:
            return {"discontinuities": 0, "realign_bytes_total": 0, "stream_offset": 0}

# ---------- Producer (integra sideband do connector + WordAligner) ----------
def producer(src: FileTailByteSource, rb: RingBuffer, chunk: int = 1 << 20):
    # começa do FIM do sideband — só reage a eventos posteriores ao arranque
    try:
        ev_pos = os.path.getsize(CONNECTOR_EVENTS)
    except OSError:
        ev_pos = 0
    while True:
        try:
            src.open()
            while True:
                # drena eventos novos do sideband do connector
                if _aligner is not None:
                    try:
                        with open(CONNECTOR_EVENTS) as f:
                            f.seek(ev_pos); new = f.read(); ev_pos = f.tell()
                        for e in parse_connector_events(new):
                            if e.get("event") == "reconnect":
                                with _align_lock:
                                    _aligner.note_reconnect(int(e.get("forwarded_offset", 0)),
                                                            float(e.get("backoff_s", 0)))
                    except OSError:
                        pass
                raw = src.read(chunk)
                if _aligner is not None:
                    with _align_lock:
                        aligned = _aligner.feed(raw)
                else:
                    aligned = raw
                before = rb.total_pushed - rb.total_popped - rb.size
                rb.push(aligned)
                after = rb.total_pushed - rb.total_popped - rb.size
                if _aligner is not None and after > before:
                    with _align_lock:
                        _aligner.note_drop_oldest(after - before)
        except Exception:
            src._close_fd()
            time.sleep(1)

# ---------- App ----------
SOURCE_FILE = "/tmp/fifo_qrng"
rb  = RingBuffer(capacity=256 * 1024 * 1024)
src = FileTailByteSource(SOURCE_FILE)
threading.Thread(target=producer, args=(src, rb), daemon=True).start()

app = FastAPI(title="QRNG Broker API")

# ---------- envelope v1 ----------
def _prov_headers(block: bytes, seq_before: int, discont_count: int,
                  realign_bytes: int, endpoint: str) -> dict:
    with rb.lock:
        lpt = rb.last_push_time
    received_at = datetime.fromtimestamp(lpt, tz=timezone.utc).isoformat() if lpt else ""
    sha = hashlib.sha256(block).hexdigest()
    cap_id = f"cap_{seq_before}_{sha[:12]}"
    status = rb.source_status()
    hdrs = {
        "X-QRNG-Provenance-Version": PROV_ENVELOPE_VERSION,
        "X-QRNG-Source-Instance":    SOURCE_INSTANCE,
        "X-QRNG-Source-Status":      status,
        "X-QRNG-Received-At":        received_at,
        "X-QRNG-Entropy-Health":     "not_assessed",
        "X-QRNG-Capture-Id":         cap_id,
        "X-QRNG-Sequence":           str(seq_before),
        "X-QRNG-Block-SHA256":       sha,
        "X-QRNG-Byte-Count":         str(len(block)),
        "X-QRNG-Transport-Format":   STREAM_FORMAT,
        "X-QRNG-Buffer-Discontinuous": "true" if discont_count else "false",
        "X-QRNG-Discontinuities":    str(discont_count),
        "X-QRNG-Realign-Bytes":      str(realign_bytes),
        "X-QRNG-Conditioned":        str(CONDITIONED).lower(),
        "X-QRNG-Format":             STREAM_FORMAT,
        "X-QRNG-Sample-Width":       str(SAMPLE_WIDTH_BYTES),
    }
    rec = {"capture_id": cap_id, "received_at": received_at, "captured_at": None,
           "sequence": seq_before, "byte_count": len(block), "sha256": sha,
           "source_status": status, "entropy_health": "not_assessed",
           "discontinuities": discont_count, "realign_bytes": realign_bytes,
           "source_instance": SOURCE_INSTANCE, "transport_format": STREAM_FORMAT}
    with _cap_lock:
        _cap_reg[cap_id] = rec
        while len(_cap_reg) > _CAP_MAX:
            _cap_reg.popitem(last=False)
    try:
        with open(CAPTURE_LOG, "a") as f:
            f.write(_json.dumps({"ts": datetime.now(timezone.utc).isoformat(),
                                 "endpoint": endpoint, **rec}) + "\n")
    except OSError:
        pass
    return hdrs

# ── /health (aditivo: envelope/alinhamento) ──────────────────────────────────
@app.get("/health")
def health():
    with rb.lock:
        size = rb.size
        tp   = rb.total_pushed
        pop  = rb.total_popped
        lpt  = rb.last_push_time
    stall = round(time.time() - lpt, 1) if lpt > 0 else None
    st = _aligner_state()
    return {
        "buffer_bytes_available": size,
        "buffer_capacity":        rb.capacity,
        "total_pushed":           tp,
        "total_popped":           pop,
        "source_file":            SOURCE_FILE,
        "source_status":          rb.source_status(),
        "source_stall_seconds":   stall,
        "stream_format":          STREAM_FORMAT,
        "sample_width_bytes":     SAMPLE_WIDTH_BYTES,
        "conditioned":            CONDITIONED,
        # aditivos v1.2
        "provenance_envelope_version": PROV_ENVELOPE_VERSION,
        "source_instance":        SOURCE_INSTANCE,
        "entropy_health":         "not_assessed",
        "transport_align": {
            "stream_offset":       st.get("stream_offset", 0),
            "discontinuities":     st.get("discontinuities", 0),
            "realign_bytes_total": st.get("realign_bytes_total", 0),
            "reconnects":          st.get("reconnects", 0),
        },
    }

# ── /random (corpo inalterado + headers v1.2) ────────────────────────────────
@app.get("/random")
def get_random(bytes: int = Query(1024, ge=1, le=50 * 1024 * 1024),
               format: str = Query("binary")):
    data, seq, dc, rb_ = rb.pop_with_prov(bytes, timeout=POP_TIMEOUT)
    if data is None:
        return JSONResponse(status_code=503, content={
            "error": "QRNG source temporarily unavailable",
            "source_status": rb.source_status(),
            "buffer_bytes_available": rb.size})
    prov = _prov_headers(data, seq, dc, rb_, "/random")
    if format == "hex":
        return JSONResponse({"random": data.hex(), "hex": data.hex(),
                             "bytes": len(data), "source": "fpga",
                             "generator": "Dobslit QRNG / Red Pitaya FPGA"},
                            headers=prov)
    return Response(content=data, media_type="application/octet-stream", headers=prov)

# ── /random_hex (corpo inalterado + headers) ─────────────────────────────────
@app.get("/random_hex")
def get_random_hex(bytes: int = Query(32, ge=1, le=50 * 1024 * 1024)):
    data, seq, dc, rb_ = rb.pop_with_prov(bytes, timeout=POP_TIMEOUT)
    if data is None:
        return JSONResponse(status_code=503, content={
            "error": "QRNG source temporarily unavailable",
            "buffer_bytes_available": rb.size})
    return JSONResponse({"bytes": len(data), "hex": data.hex()},
                        headers=_prov_headers(data, seq, dc, rb_, "/random_hex"))

# ── /stream (inalterado — sem envelope; documentado) ─────────────────────────
@app.get("/stream")
def stream():
    def gen():
        while True:
            yield rb.pop(1 << 20)
    return StreamingResponse(gen(), media_type="application/octet-stream")

# ── /v1/raw (corpo inalterado + envelope) ────────────────────────────────────
@app.get("/v1/raw")
def v1_raw(bytes: int = Query(1024, ge=4, le=50 * 1024 * 1024)):
    aligned = (bytes // SAMPLE_WIDTH_BYTES) * SAMPLE_WIDTH_BYTES
    if aligned == 0:
        return JSONResponse(status_code=400,
                            content={"error": "bytes must be >= 4 (one uint32 sample)"})
    data, seq, dc, rb_ = rb.pop_with_prov(aligned, timeout=POP_TIMEOUT)
    if data is None:
        return JSONResponse(status_code=503, content={
            "error": "QRNG source temporarily unavailable",
            "source_status": rb.source_status(),
            "buffer_bytes_available": rb.size})
    prov = _prov_headers(data, seq, dc, rb_, "/v1/raw")
    prov["X-QRNG-Bytes"]   = str(len(data))
    prov["X-QRNG-Samples"] = str(len(data) // SAMPLE_WIDTH_BYTES)
    return Response(content=data, media_type="application/octet-stream", headers=prov)

# ── /v1/uint32 (corpo inalterado + envelope) ─────────────────────────────────
_UINT32_MAX_COUNT = 131072

@app.get("/v1/uint32")
def v1_uint32(count: int = Query(256, ge=1, le=_UINT32_MAX_COUNT)):
    n_bytes = count * SAMPLE_WIDTH_BYTES
    data, seq, dc, rb_ = rb.pop_with_prov(n_bytes, timeout=POP_TIMEOUT)
    if data is None:
        return JSONResponse(status_code=503, content={
            "error": "QRNG source temporarily unavailable",
            "source_status": rb.source_status(),
            "buffer_bytes_available": rb.size})
    values = list(struct.unpack(f"<{count}I", data))
    return JSONResponse({"count": count, "values": values, "source": "fpga",
                         "stream_format": STREAM_FORMAT, "conditioned": CONDITIONED,
                         "generator": "Dobslit QRNG / Red Pitaya FPGA"},
                        headers=_prov_headers(data, seq, dc, rb_, "/v1/uint32"))

# ── /v1/capture/{id} (novo — consulta, sem bytes) ────────────────────────────
@app.get("/v1/capture/{capture_id}")
def v1_capture(capture_id: str):
    with _cap_lock:
        rec = _cap_reg.get(capture_id)
    if rec is None:
        return JSONResponse(status_code=404,
                            content={"error": "capture_id desconhecido", "capture_id": capture_id})
    return JSONResponse(rec)
