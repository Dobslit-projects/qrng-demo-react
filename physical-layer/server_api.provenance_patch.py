# -*- coding: utf-8 -*-
# =============================================================================
# REFERÊNCIA — NÃO APLICADO. Patch do `server_api.py` de PRODUÇÃO (dobslit) para:
#   - envelope de proveniência v1 (item 9);
#   - X-QRNG-Received-At (item 4) — instante em que o broker RECEBEU os bytes.
#     NÃO usar "Captured-At": não há carimbo físico da FPGA (o `fifo.c` não o
#     produz — ver FPGA_INSPECTION_RESULT.md). `captured_at` fica reservado.
#   - X-QRNG-Entropy-Health = "not_assessed" (item 5) — SEPARADO do transporte e
#     do buffer. RCT/APT não rodam no caminho live.
#   - offset monótono + realinhamento de palavra + descontinuidade (itens 2/3),
#     integrando `physical-layer/transport_align.py` (WordAligner) no produtor,
#     alimentado pelo sideband do `qrng-connector.staging.py`.
#
# Aplicar SÓ numa janela autorizada de manutenção do upstream. NÃO altera o
# corpo das respostas — só headers, um endpoint de consulta e um log JSONL.
# Linhas marcadas `# +++` são novas.
# =============================================================================

# ---------------------------------------------------------------------------
# 1) topo do arquivo — imports e config do envelope
# ---------------------------------------------------------------------------
import hashlib                                                          # +++
import json as _json                                                   # +++
from collections import OrderedDict                                     # +++
from datetime import datetime, timezone                                 # +++

PROVENANCE_ENVELOPE_VERSION = "1"                                       # +++
SOURCE_INSTANCE = "dobslit-qrng-ufpe-fpga"                              # +++  (config)
CAPTURE_LOG_PATH = "/var/log/qrng/captures.jsonl"                       # +++  (logrotate à parte)
_capture_reg = OrderedDict()   # capture_id -> registro (sem bytes)     # +++
_CAP_REG_MAX = 1024                                                     # +++
_cap_lock = threading.Lock()                                           # +++


# ---------------------------------------------------------------------------
# 2) PRODUTOR — integrar o WordAligner (physical-layer/transport_align.py):
#    alimentado pelo sideband JSONL do `qrng-connector.staging.py`
#    (QRNG_CONNECTOR_EVENTS). Garante que só palavras completas entram no ring
#    buffer, aplica o realinhamento após uma reconexão e conta descontinuidades.
# ---------------------------------------------------------------------------
# from transport_align import WordAligner, parse_connector_events           # +++
# _aligner = WordAligner()                                                  # +++
#
# def producer(src, rb, chunk=1<<20):                                       # (patched)
#     import os
#     ev_path = os.environ.get("QRNG_CONNECTOR_EVENTS", "/tmp/qrng_connector_events.jsonl")
#     ev_pos = 0
#     src.open()
#     while True:
#         # drena eventos novos do sideband ANTES de processar dados
#         try:
#             with open(ev_path) as f:
#                 f.seek(ev_pos); new = f.read(); ev_pos = f.tell()
#             for e in parse_connector_events(new):
#                 if e.get("event") == "reconnect":
#                     _aligner.note_reconnect(e.get("forwarded_offset", 0), e.get("backoff_s", 0))
#         except OSError:
#             pass
#         raw = src.read(chunk)
#         aligned = _aligner.feed(raw)          # só palavras completas + realinhamento
#         before = rb.total_pushed - rb.total_popped - rb.size
#         rb.push(aligned)
#         after = rb.total_pushed - rb.total_popped - rb.size
#         if after > before:
#             _aligner.note_drop_oldest(after - before)
#
# ---------------------------------------------------------------------------
# 2b) RingBuffer.pop_with_prov — devolve (data, seq_before, discont_count,
#     realign_bytes). NÃO muda os bytes.
# ---------------------------------------------------------------------------
class _RingBufferProvMixin:                                            # +++
    def pop_with_prov(self, n: int, timeout: float):                   # +++
        """Como pop_timeout, mas devolve
        (data, seq_before, discont_count, realign_bytes)."""
        with self.not_empty:
            seq_before = self.total_popped
            deadline = time.time() + timeout
            while self.size < n:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None, seq_before, 0, 0
                self.not_empty.wait(timeout=remaining)
            data = self._read_n(n)
            st = _aligner.state()                                      # noqa: F821 (ref)
            return data, seq_before, st["discontinuities"], st["realign_bytes_total"]


# ---------------------------------------------------------------------------
# 3) helper de envelope + log
# ---------------------------------------------------------------------------
def _prov_headers(block: bytes, seq_before: int, discont_count: int,    # +++
                  realign_bytes: int, endpoint: str) -> dict:
    """Envelope v1. `X-QRNG-Received-At` = last_push_time do ring buffer
    (instante em que os bytes MAIS RECENTES entraram no broker). NÃO é a
    detecção física — é a fronteira de frescor verificável sem tocar a FPGA.
    `X-QRNG-Captured-At` NÃO é emitido (sem carimbo da FPGA). `discont_count` e
    `realign_bytes` vêm do WordAligner (transport_align.py) alimentado pelo
    sideband do connector."""
    with rb.lock:
        lpt = rb.last_push_time
    received_at = datetime.fromtimestamp(lpt, tz=timezone.utc).isoformat() if lpt else None
    sha = hashlib.sha256(block).hexdigest()
    cap_id = f"cap_{seq_before}_{sha[:12]}"
    status = rb.source_status()                 # eixo TRANSPORTE
    hdrs = {
        "X-QRNG-Provenance-Version": PROVENANCE_ENVELOPE_VERSION,
        "X-QRNG-Source-Instance": SOURCE_INSTANCE,
        "X-QRNG-Source-Status": status,
        "X-QRNG-Received-At": received_at or "",                # item 4
        "X-QRNG-Entropy-Health": "not_assessed",               # item 5 (RCT/APT off)
        "X-QRNG-Capture-Id": cap_id,
        "X-QRNG-Sequence": str(seq_before),                    # offset monótono (itens 2/3)
        "X-QRNG-Block-SHA256": sha,
        "X-QRNG-Byte-Count": str(len(block)),
        "X-QRNG-Transport-Format": STREAM_FORMAT,
        "X-QRNG-Buffer-Discontinuous": "true" if discont_count else "false",  # eixo BUFFER
        "X-QRNG-Discontinuities": str(discont_count),
        "X-QRNG-Realign-Bytes": str(realign_bytes),
        "X-QRNG-Conditioned": str(CONDITIONED).lower(),
    }
    rec = {"ts": datetime.now(timezone.utc).isoformat(), "capture_id": cap_id,
           "received_at": received_at, "captured_at": None, "sequence": seq_before,
           "byte_count": len(block), "sha256": sha, "source_status": status,
           "entropy_health": "not_assessed", "discontinuities": discont_count,
           "realign_bytes": realign_bytes,
           "source_instance": SOURCE_INSTANCE, "transport_format": STREAM_FORMAT,
           "endpoint": endpoint}
    with _cap_lock:
        _capture_reg[cap_id] = {k: rec[k] for k in
                                ("capture_id", "captured_at", "sequence", "byte_count",
                                 "sha256", "source_status", "source_instance", "transport_format")}
        while len(_capture_reg) > _CAP_REG_MAX:
            _capture_reg.popitem(last=False)
    try:
        with open(CAPTURE_LOG_PATH, "a") as f:
            f.write(_json.dumps(rec) + "\n")
    except OSError:
        pass  # log é best-effort; nunca derruba a resposta
    return hdrs


# ---------------------------------------------------------------------------
# 4) /v1/raw — trocar o pop e ACRESCENTAR headers (corpo inalterado)
# ---------------------------------------------------------------------------
#   ANTES:
#     data = rb.pop_timeout(aligned, timeout=POP_TIMEOUT)
#     ...
#     return Response(content=data, media_type="application/octet-stream",
#                     headers={**_RAW_HEADERS, "X-QRNG-Bytes": str(len(data)),
#                              "X-QRNG-Samples": str(len(data)//SAMPLE_WIDTH_BYTES)})
#   DEPOIS:
def v1_raw_patched(bytes_):                                            # +++ (esqueleto)
    aligned = (bytes_ // SAMPLE_WIDTH_BYTES) * SAMPLE_WIDTH_BYTES
    res = rb.pop_with_prov(aligned, timeout=POP_TIMEOUT)               # +++
    data, seq_before, discont_count, realign_bytes = res              # +++
    if data is None:
        # ... 503 igual ao original ...
        return None
    prov = _prov_headers(data, seq_before, discont_count,             # +++
                         realign_bytes, "/v1/raw")
    return Response(                                                   # (mesmo corpo)
        content=data, media_type="application/octet-stream",
        headers={**_RAW_HEADERS,
                 "X-QRNG-Bytes": str(len(data)),
                 "X-QRNG-Samples": str(len(data) // SAMPLE_WIDTH_BYTES),
                 **prov},                                              # +++
    )

# Mesma alteração em /random (binário e hex) e /v1/uint32: pop_with_prov + **prov
# nos headers. O JSON de /random?format=hex e /v1/uint32 NÃO muda (só headers).


# ---------------------------------------------------------------------------
# 5) endpoint de consulta (auditoria/replay) — NÃO devolve bytes
# ---------------------------------------------------------------------------
# @app.get("/v1/capture/{capture_id}")
def v1_capture_patched(capture_id: str):                               # +++
    with _cap_lock:
        rec = _capture_reg.get(capture_id)
    if rec is None:
        return JSONResponse(status_code=404,
                            content={"error": "capture_id desconhecido",
                                     "capture_id": capture_id})
    return JSONResponse(rec)


# ---------------------------------------------------------------------------
# 6) o que NÃO muda
# ---------------------------------------------------------------------------
#  - o corpo de /v1/raw, /random, /stream: byte-idêntico ao atual;
#  - FileTailByteSource, producer, RingBuffer.push/_read_n: intocados;
#  - nenhum segundo consumidor de /tmp/fifo_qrng;
#  - /stream (chunked) NÃO recebe o envelope (headers só no início da resposta);
#    /stream não é caminho de proveniência auditável — documentar.
#
#  Rollback: remover os headers extras e o endpoint; o `pop_with_prov` pode
#  ficar (é aditivo e não altera semântica de pop).
