#!/usr/bin/env python3
"""
QRNG Broker API — binary uint32-LE stream (v1.1)
Compatível com v1.0 (todos os endpoints existentes preservados).
Mudanças nesta versão:
  - /health: campos stream_format, sample_width_bytes, conditioned (aditivos)
  - /v1/raw: endpoint binário explicitamente documentado como uint32-le, unconditioned
  - /v1/uint32: retorna count uint32 como JSON array
"""
import os, time, threading, struct
from fastapi import FastAPI, Query, Response
from fastapi.responses import StreamingResponse, JSONResponse

SOURCE_OFFLINE_THRESHOLD = 5.0
SOURCE_OFFLINE_LONG      = 60.0
POP_TIMEOUT              = 2.0

STREAM_FORMAT      = "uint32-le"
SAMPLE_WIDTH_BYTES = 4
CONDITIONED        = False        # fonte bruta, sem conditioning

# ---------- FIFO tail reader ----------
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

# ---------- Ring buffer ----------
class RingBuffer:
    def __init__(self, capacity: int):
        self.buf            = bytearray(capacity)
        self.capacity       = capacity
        self.head           = self.tail = self.size = 0
        self.lock           = threading.Lock()
        self.not_empty      = threading.Condition(self.lock)
        self.total_pushed   = 0
        self.total_popped   = 0
        self.last_push_time = 0.0

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

# ---------- Producer ----------
def producer(src: FileTailByteSource, rb: RingBuffer, chunk: int = 1 << 20):
    while True:
        try:
            src.open()
            while True:
                data = src.read(chunk)
                rb.push(data)
        except Exception:
            src._close_fd()
            time.sleep(1)

# ---------- App ----------
SOURCE_FILE = "/tmp/fifo_qrng"

rb  = RingBuffer(capacity=256 * 1024 * 1024)
src = FileTailByteSource(SOURCE_FILE)
threading.Thread(target=producer, args=(src, rb), daemon=True).start()

app = FastAPI(title="QRNG Broker API")

# ── /health ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    with rb.lock:
        size = rb.size
        tp   = rb.total_pushed
        pop  = rb.total_popped
        lpt  = rb.last_push_time
    stall = round(time.time() - lpt, 1) if lpt > 0 else None
    return {
        # Campos originais — nomes e tipos inalterados
        "buffer_bytes_available": size,
        "buffer_capacity":        rb.capacity,
        "total_pushed":           tp,
        "total_popped":           pop,
        "source_file":            SOURCE_FILE,
        "source_status":          rb.source_status(),
        "source_stall_seconds":   stall,
        # Campos novos (aditivos — descrevem o formato do stream)
        "stream_format":          STREAM_FORMAT,
        "sample_width_bytes":     SAMPLE_WIDTH_BYTES,
        "conditioned":            CONDITIONED,
    }

# ── /random (original — preservado) ──────────────────────────────────────────

@app.get("/random")
def get_random(
    bytes:  int = Query(1024, ge=1, le=50 * 1024 * 1024),
    format: str = Query("binary"),
):
    data = rb.pop_timeout(bytes, timeout=POP_TIMEOUT)
    if data is None:
        return JSONResponse(
            status_code=503,
            content={
                "error":                  "QRNG source temporarily unavailable",
                "source_status":          rb.source_status(),
                "buffer_bytes_available": rb.size,
            }
        )
    if format == "hex":
        return JSONResponse({
            "random":    data.hex(),
            "hex":       data.hex(),
            "bytes":     len(data),
            "source":    "fpga",
            "generator": "Dobslit QRNG / Red Pitaya FPGA",
        })
    return Response(content=data, media_type="application/octet-stream")

# ── /random_hex (original — preservado) ──────────────────────────────────────

@app.get("/random_hex")
def get_random_hex(bytes: int = Query(32, ge=1, le=50 * 1024 * 1024)):
    data = rb.pop_timeout(bytes, timeout=POP_TIMEOUT)
    if data is None:
        return JSONResponse(
            status_code=503,
            content={
                "error":                  "QRNG source temporarily unavailable",
                "buffer_bytes_available": rb.size,
            }
        )
    return JSONResponse({"bytes": len(data), "hex": data.hex()})

# ── /stream (original — preservado) ──────────────────────────────────────────

@app.get("/stream")
def stream():
    def gen():
        while True:
            yield rb.pop(1 << 20)
    return StreamingResponse(gen(), media_type="application/octet-stream")

# ── /v1/raw (novo) ────────────────────────────────────────────────────────────

_RAW_HEADERS = {
    "X-QRNG-Format":       STREAM_FORMAT,
    "X-QRNG-Sample-Width": str(SAMPLE_WIDTH_BYTES),
    "X-QRNG-Conditioned":  str(CONDITIONED).lower(),
}

@app.get("/v1/raw")
def v1_raw(bytes: int = Query(1024, ge=4, le=50 * 1024 * 1024)):
    # Arredondar para baixo até múltiplo de SAMPLE_WIDTH_BYTES
    aligned = (bytes // SAMPLE_WIDTH_BYTES) * SAMPLE_WIDTH_BYTES
    if aligned == 0:
        return JSONResponse(
            status_code=400,
            content={"error": "bytes must be >= 4 (one uint32 sample)"},
        )
    data = rb.pop_timeout(aligned, timeout=POP_TIMEOUT)
    if data is None:
        return JSONResponse(
            status_code=503,
            content={
                "error":                  "QRNG source temporarily unavailable",
                "source_status":          rb.source_status(),
                "buffer_bytes_available": rb.size,
            }
        )
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            **_RAW_HEADERS,
            "X-QRNG-Bytes":   str(len(data)),
            "X-QRNG-Samples": str(len(data) // SAMPLE_WIDTH_BYTES),
        },
    )

# ── /v1/uint32 (novo) ─────────────────────────────────────────────────────────

_UINT32_MAX_COUNT = 131072   # 512 KB / 4 bytes

@app.get("/v1/uint32")
def v1_uint32(count: int = Query(256, ge=1, le=_UINT32_MAX_COUNT)):
    n_bytes = count * SAMPLE_WIDTH_BYTES
    data = rb.pop_timeout(n_bytes, timeout=POP_TIMEOUT)
    if data is None:
        return JSONResponse(
            status_code=503,
            content={
                "error":                  "QRNG source temporarily unavailable",
                "source_status":          rb.source_status(),
                "buffer_bytes_available": rb.size,
            }
        )
    # Desserializar como uint32 little-endian
    values = list(struct.unpack(f"<{count}I", data))
    return JSONResponse({
        "count":            count,
        "values":           values,
        "source":           "fpga",
        "stream_format":    STREAM_FORMAT,
        "conditioned":      CONDITIONED,
        "generator":        "Dobslit QRNG / Red Pitaya FPGA",
    })
