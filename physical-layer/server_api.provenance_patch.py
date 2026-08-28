# -*- coding: utf-8 -*-
# =============================================================================
# REFERÊNCIA — NÃO APLICADO. Patch do `server_api.py` de PRODUÇÃO para emitir o
# envelope de proveniência v1 (fase item 9). Ver physical-layer/UPSTREAM_PROVENANCE.md.
#
# Aplicar SÓ numa janela autorizada de manutenção do upstream (dobslit VM,
# /home/dobslit/qrng-api/server_api.py). NÃO altera o corpo das respostas —
# só ACRESCENTA headers e um endpoint de consulta + log JSONL.
#
# Este arquivo mostra os trechos a inserir/trocar, com contexto suficiente para
# um diff manual. As linhas marcadas `# +++` são novas.
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
# 2) RingBuffer.pop / _read_n — retornar também o "sequence" (total_popped
#    ANTES deste pop) e sinal de descontinuidade. NÃO muda os bytes.
#    Acrescentar um método auxiliar (não tocar pop/_read_n existentes):
# ---------------------------------------------------------------------------
class _RingBufferProvMixin:                                            # +++
    def pop_with_prov(self, n: int, timeout: float):                   # +++
        """Como pop_timeout, mas devolve (data, seq_before, discontinuous).
        `discontinuous` = houve drop-oldest desde o pop anterior."""
        with self.not_empty:
            # snapshot antes
            dropped_before = self.total_pushed - self.total_popped - self.size
            seq_before = self.total_popped
            deadline = time.time() + timeout
            while self.size < n:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None, seq_before, False
                self.not_empty.wait(timeout=remaining)
            data = self._read_n(n)
            dropped_after = self.total_pushed - self.total_popped - self.size
            return data, seq_before, (dropped_after > dropped_before)

# (na definição real: adicionar `pop_with_prov` diretamente em RingBuffer, ou
#  fazer `class RingBuffer(_RingBufferProvMixin): ...`.)


# ---------------------------------------------------------------------------
# 3) helper de envelope + log
# ---------------------------------------------------------------------------
def _prov_headers(block: bytes, seq_before: int, discontinuous: bool,   # +++
                  endpoint: str) -> dict:
    """Envelope v1. `X-QRNG-Captured-At` = last_push_time do ring buffer
    (instante em que os bytes MAIS RECENTES entraram no broker) — NÃO é o
    instante da detecção física; é a fronteira de frescor verificável sem
    tocar a FPGA."""
    with rb.lock:
        lpt = rb.last_push_time
    captured_at = datetime.fromtimestamp(lpt, tz=timezone.utc).isoformat() if lpt else None
    sha = hashlib.sha256(block).hexdigest()
    cap_id = f"cap_{seq_before}_{sha[:12]}"
    status = rb.source_status()
    hdrs = {
        "X-QRNG-Provenance-Version": PROVENANCE_ENVELOPE_VERSION,
        "X-QRNG-Source-Instance": SOURCE_INSTANCE,
        "X-QRNG-Source-Status": status,
        "X-QRNG-Captured-At": captured_at or "",
        "X-QRNG-Capture-Id": cap_id,
        "X-QRNG-Sequence": str(seq_before),
        "X-QRNG-Block-SHA256": sha,
        "X-QRNG-Byte-Count": str(len(block)),
        "X-QRNG-Transport-Format": STREAM_FORMAT,
        "X-QRNG-Buffer-Discontinuous": "true" if discontinuous else "false",
        "X-QRNG-Conditioned": str(CONDITIONED).lower(),
    }
    rec = {"ts": datetime.now(timezone.utc).isoformat(), "capture_id": cap_id,
           "captured_at": captured_at, "sequence": seq_before,
           "byte_count": len(block), "sha256": sha, "source_status": status,
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
    data, seq_before, discont = res                                   # +++
    if data is None:
        # ... 503 igual ao original ...
        return None
    prov = _prov_headers(data, seq_before, discont, "/v1/raw")        # +++
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
