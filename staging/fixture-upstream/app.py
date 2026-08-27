# -*- coding: utf-8 -*-
"""Fixture upstream para o STAGING do Kapua QRNG (fase item 2).

Imita o CONTRATO de server_api.py (/health, /random, /v1/raw, /v1/uint32,
/stream) mas serve bytes de REPLAY DETERMINISTICO gerados por uma PRNG com
seed fixa. NUNCA toca 10.0.10.2 nem /tmp/fifo_qrng nem a conexao exclusiva
da fonte de producao.

Proveniencia: toda resposta declara replay (header X-QRNG-Provenance: replay
e campo provenance nos JSON). Nenhuma resposta e rotulada 'live'.

Controle p/ testes (staging apenas): POST /_ctl/offline e /_ctl/online
alternam entre servir bytes e devolver 503 (para exercitar fallback/erros).
"""
import io
import os
import struct
import random
import time
import threading

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

_state = {"online": True, "cursor": 0, "total_pushed": 0, "total_popped": 0,
          "last_push": time.time()}
_lock = threading.Lock()


def _take(n: int) -> bytes:
    """Devolve n bytes deterministicos do pool (com wrap). Avanca o cursor."""
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


app = FastAPI(title="Kapua QRNG STAGING fixture upstream (replay)")


@app.middleware("http")
async def _prov_header(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-QRNG-Provenance"] = PROVENANCE
    resp.headers["X-QRNG-Environment"] = "staging"
    return resp


@app.post("/_ctl/offline")
def ctl_offline():
    _state["online"] = False
    return {"online": False}


@app.post("/_ctl/online")
def ctl_online():
    _state["online"] = True
    return {"online": True}


@app.post("/_ctl/reset")
def ctl_reset():
    with _lock:
        _state["cursor"] = 0
    return {"cursor": 0}


@app.get("/health")
def health():
    online = _state["online"]
    return {
        "buffer_bytes_available": POOL_BYTES if online else 0,
        "buffer_capacity": POOL_BYTES,
        "total_pushed": _state["total_pushed"],
        "total_popped": _state["total_popped"],
        "source_file": "(fixture-replay)",
        "source_status": "online" if online else "offline",
        "source_stall_seconds": 0.0 if online else 999.0,
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
    )


@app.get("/random")
def get_random(bytes: int = Query(1024, ge=1, le=50 * 1024 * 1024),
               format: str = Query("binary")):
    if not _state["online"]:
        return _offline_503()
    data = _take(bytes)
    if format == "hex":
        return JSONResponse({"random": data.hex(), "hex": data.hex(),
                             "bytes": len(data), "source": "fixture-replay",
                             "provenance": PROVENANCE,
                             "generator": "STAGING fixture (deterministic replay)"})
    return Response(content=data, media_type="application/octet-stream")


@app.get("/random_hex")
def get_random_hex(bytes: int = Query(32, ge=1, le=50 * 1024 * 1024)):
    if not _state["online"]:
        return _offline_503()
    data = _take(bytes)
    return JSONResponse({"bytes": len(data), "hex": data.hex(), "provenance": PROVENANCE})


@app.get("/v1/raw")
def v1_raw(bytes: int = Query(1024, ge=4, le=50 * 1024 * 1024)):
    if not _state["online"]:
        return _offline_503()
    aligned = (bytes // SAMPLE_WIDTH_BYTES) * SAMPLE_WIDTH_BYTES
    if aligned == 0:
        return JSONResponse(status_code=400,
                            content={"error": "bytes must be >= 4 (one uint32 sample)"})
    data = _take(aligned)
    return Response(content=data, media_type="application/octet-stream", headers={
        "X-QRNG-Format": STREAM_FORMAT,
        "X-QRNG-Sample-Width": str(SAMPLE_WIDTH_BYTES),
        "X-QRNG-Conditioned": str(CONDITIONED).lower(),
        "X-QRNG-Bytes": str(len(data)),
        "X-QRNG-Samples": str(len(data) // SAMPLE_WIDTH_BYTES),
    })


@app.get("/v1/uint32")
def v1_uint32(count: int = Query(256, ge=1, le=131072)):
    if not _state["online"]:
        return _offline_503()
    data = _take(count * SAMPLE_WIDTH_BYTES)
    values = list(struct.unpack(f"<{count}I", data))
    return JSONResponse({"count": count, "values": values, "source": "fixture-replay",
                         "stream_format": STREAM_FORMAT, "conditioned": CONDITIONED,
                         "provenance": PROVENANCE,
                         "generator": "STAGING fixture (deterministic replay)"})


@app.get("/stream")
def stream():
    def gen():
        while _state["online"]:
            yield _take(1 << 16)
            time.sleep(0.01)
    return StreamingResponse(gen(), media_type="application/octet-stream")
