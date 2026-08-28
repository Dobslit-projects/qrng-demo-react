# -*- coding: utf-8 -*-
"""Fixture upstream para o STAGING do Kapua QRNG (fase itens 2 e 3).

Imita o CONTRATO de server_api.py (/health, /random, /v1/raw, /v1/uint32,
/stream) mas serve bytes de REPLAY DETERMINISTICO gerados por uma PRNG com
seed fixa. NUNCA toca 10.0.10.2 nem /tmp/fifo_qrng nem a conexao exclusiva
da fonte de producao.

Proveniencia: toda resposta declara replay (header X-QRNG-Provenance: replay
e campo provenance nos JSON). Nenhuma resposta e rotulada 'live'. Alem disso,
/random e /v1/raw emitem headers de captura por resposta para o contrato de
proveniencia do client-api (item 3):
  X-QRNG-Captured-At   ISO8601 do "instante de captura" simulado
  X-QRNG-Capture-Id    cap_<cursor> deterministico
  X-QRNG-Source-Status online | degraded | offline

Controle p/ testes (staging apenas):
  POST /_ctl/online            volta ao normal
  POST /_ctl/offline           503 em tudo (fonte caida)
  POST /_ctl/mode?mode=...     online | degraded | stale | exhausted | offline
  POST /_ctl/reset             zera o cursor (replay repetivel)
"""
import os
import struct
import random
import time
import threading
from datetime import datetime, timezone, timedelta

from fastapi import FastAPI, Query, Response, Request
from fastapi.responses import JSONResponse, StreamingResponse

SEED = int(os.getenv("FIXTURE_SEED", "20260827"))
POOL_BYTES = int(os.getenv("FIXTURE_POOL_BYTES", str(8 * 1024 * 1024)))
STREAM_FORMAT = "uint32-le"
SAMPLE_WIDTH_BYTES = 4
CONDITIONED = False
PROVENANCE = os.getenv("FIXTURE_PROVENANCE", "replay")  # replay | fixture | historical

# Pool deterministico -- os mesmos bytes toda vez, dado o mesmo SEED.
_rng = random.Random(SEED)
_POOL = bytes(_rng.getrandbits(8) for _ in range(POOL_BYTES))

# mode: online | degraded | stale | exhausted | offline
_state = {"mode": "online", "cursor": 0, "total_pushed": 0, "total_popped": 0,
          "last_push": time.time(), "exhaust_remaining": 0}
_lock = threading.Lock()


def _online() -> bool:
    return _state["mode"] != "offline"


def _take(n: int) -> bytes:
    with _lock:
        out = bytearray(n)
        c = _state["cursor"]
        for i in range(n):
            out[i] = _POOL[(c + i) % POOL_BYTES]
        _state["cursor"] = (c + n) % POOL_BYTES
        _state["total_popped"] += n
        _state["total_pushed"] += n
        _state["last_push"] = time.time()
        return bytes(out)


def _capture_headers() -> dict:
    """Headers de captura por resposta (item 3). 'stale' devolve captured_at
    antigo para o client-api derrubar o rotulo 'live' por idade."""
    mode = _state["mode"]
    if mode == "stale":
        captured = datetime.now(timezone.utc) - timedelta(hours=6)
        status = "online"
    elif mode == "degraded":
        captured = datetime.now(timezone.utc)
        status = "degraded"
    elif mode == "offline":
        captured = datetime.now(timezone.utc)
        status = "offline"
    else:  # online | exhausted
        captured = datetime.now(timezone.utc)
        status = "online"
    return {
        "X-QRNG-Captured-At": captured.isoformat(),
        "X-QRNG-Capture-Id": f"cap_{_state['cursor']}",
        "X-QRNG-Source-Status": status,
    }


app = FastAPI(title="Kapua QRNG STAGING fixture upstream (replay)")


@app.middleware("http")
async def _prov_header(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-QRNG-Provenance"] = PROVENANCE
    resp.headers["X-QRNG-Environment"] = "staging"
    return resp


@app.post("/_ctl/offline")
def ctl_offline():
    _state["mode"] = "offline"
    return {"mode": "offline"}


@app.post("/_ctl/online")
def ctl_online():
    _state["mode"] = "online"
    _state["exhaust_remaining"] = 0
    return {"mode": "online"}


@app.post("/_ctl/mode")
def ctl_mode(mode: str = Query(...), remaining: int = Query(0, ge=0)):
    if mode not in ("online", "degraded", "stale", "exhausted", "offline"):
        return JSONResponse(status_code=400, content={"error": "bad mode"})
    _state["mode"] = mode
    if mode == "exhausted":
        _state["exhaust_remaining"] = remaining or 4096
    return {"mode": mode, "exhaust_remaining": _state["exhaust_remaining"]}


@app.post("/_ctl/reset")
def ctl_reset():
    with _lock:
        _state["cursor"] = 0
    return {"cursor": 0}


@app.get("/health")
def health():
    mode = _state["mode"]
    online = _online()
    buf_avail = 0 if not online else (
        _state["exhaust_remaining"] if mode == "exhausted" else POOL_BYTES)
    return {
        "buffer_bytes_available": buf_avail,
        "buffer_capacity": POOL_BYTES,
        "total_pushed": _state["total_pushed"],
        "total_popped": _state["total_popped"],
        "source_file": "(fixture-replay)",
        "source_status": "online" if online else "offline",
        "source_mode": mode,
        "source_stall_seconds": 0.0 if mode == "online" else (999.0 if not online else 5.0),
        "stream_format": STREAM_FORMAT,
        "sample_width_bytes": SAMPLE_WIDTH_BYTES,
        "conditioned": CONDITIONED,
        "provenance": PROVENANCE,
        "environment": "staging",
        "fixture_seed": SEED,
    }


def _offline_503():
    return JSONResponse(
        status_code=503,
        content={"error": "QRNG source temporarily unavailable (fixture offline)",
                 "source_status": "offline", "buffer_bytes_available": 0,
                 "provenance": PROVENANCE},
        headers={"X-QRNG-Source-Status": "offline"},
    )


def _serve_bytes(n: int) -> bytes:
    """Aplica o modo 'exhausted': serve no maximo o que resta, entao seca."""
    if _state["mode"] != "exhausted":
        return _take(n)
    with _lock:
        rem = _state["exhaust_remaining"]
    if rem <= 0:
        return b""
    give = min(n, rem)
    data = _take(give)
    with _lock:
        _state["exhaust_remaining"] = max(0, _state["exhaust_remaining"] - give)
    return data


@app.get("/random")
def get_random(bytes: int = Query(1024, ge=1, le=50 * 1024 * 1024),
               format: str = Query("binary")):
    if not _online():
        return _offline_503()
    data = _serve_bytes(bytes)
    if format == "hex":
        return JSONResponse({"random": data.hex(), "hex": data.hex(),
                             "bytes": len(data), "source": "fixture-replay",
                             "provenance": PROVENANCE,
                             "generator": "STAGING fixture (deterministic replay)"},
                            headers=_capture_headers())
    return Response(content=data, media_type="application/octet-stream",
                    headers=_capture_headers())


@app.get("/random_hex")
def get_random_hex(bytes: int = Query(32, ge=1, le=50 * 1024 * 1024)):
    if not _online():
        return _offline_503()
    data = _serve_bytes(bytes)
    return JSONResponse({"bytes": len(data), "hex": data.hex(), "provenance": PROVENANCE},
                        headers=_capture_headers())


@app.get("/v1/raw")
def v1_raw(bytes: int = Query(1024, ge=4, le=50 * 1024 * 1024)):
    if not _online():
        return _offline_503()
    aligned = (bytes // SAMPLE_WIDTH_BYTES) * SAMPLE_WIDTH_BYTES
    if aligned == 0:
        return JSONResponse(status_code=400,
                            content={"error": "bytes must be >= 4 (one uint32 sample)"})
    data = _serve_bytes(aligned)
    hdrs = {
        "X-QRNG-Format": STREAM_FORMAT,
        "X-QRNG-Sample-Width": str(SAMPLE_WIDTH_BYTES),
        "X-QRNG-Conditioned": str(CONDITIONED).lower(),
        "X-QRNG-Bytes": str(len(data)),
        "X-QRNG-Samples": str(len(data) // SAMPLE_WIDTH_BYTES),
        **_capture_headers(),
    }
    return Response(content=data, media_type="application/octet-stream", headers=hdrs)


@app.get("/v1/uint32")
def v1_uint32(count: int = Query(256, ge=1, le=131072)):
    if not _online():
        return _offline_503()
    data = _take(count * SAMPLE_WIDTH_BYTES)
    values = list(struct.unpack(f"<{count}I", data))
    return JSONResponse({"count": count, "values": values, "source": "fixture-replay",
                         "stream_format": STREAM_FORMAT, "conditioned": CONDITIONED,
                         "provenance": PROVENANCE,
                         "generator": "STAGING fixture (deterministic replay)"},
                        headers=_capture_headers())


@app.get("/stream")
def stream():
    def gen():
        while _online():
            yield _take(1 << 16)
            time.sleep(0.01)
    return StreamingResponse(gen(), media_type="application/octet-stream")
