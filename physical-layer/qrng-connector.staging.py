#!/usr/bin/env python3
"""QRNG Connector — versão STAGING (item 2: alinhamento + descontinuidade).

**NÃO IMPLANTADO.** O que roda na dobslit é `qrng-connector.py` (baseline).
Esta versão acrescenta, SEM mudar o payload de bytes no stdout:

  1. `total_forwarded` monótono (bytes repassados ao stdout);
  2. um SIDEBAND JSONL (`QRNG_CONNECTOR_EVENTS`, fora do stream) com
     `{"event":"connect|reconnect","forwarded_offset":N,"ts":...,"backoff_s":B,
       "prev_conn_bytes":M}` — o `server_api.py` usa `forwarded_offset` para
     realinhar o grid uint32 (ver `physical-layer/transport_align.py`);
  3. segura a cauda de palavra incompleta (0-3 bytes) DENTRO de uma conexão,
     repassando só palavras completas de 4 bytes — assim o leitor a jusante
     nunca vê uma palavra torturada no meio de um `read()`.

Reconexão continua NÃO recuperando bytes perdidos na rede (impossível sem
número de sequência da FPGA) — mas agora a perda é REGISTRADA e o grid é
re-encaixado a jusante.
"""
import json
import os
import socket
import sys
import time

HOST      = os.environ.get("QRNG_FPGA_HOST", "10.0.10.2")
PORT      = int(os.environ.get("QRNG_FPGA_PORT", "12345"))
CHUNK     = 65536
RETRY_MIN = 2
RETRY_MAX = 30
WORD      = 4
EVENTS    = os.environ.get("QRNG_CONNECTOR_EVENTS", "/tmp/qrng_connector_events.jsonl")

total_forwarded = 0          # bytes de palavra COMPLETA repassados ao stdout
_rem = b""                   # 0-3 bytes de cauda de palavra incompleta (por conexão)


def emit_event(ev: str, **kw) -> None:
    rec = {"event": ev, "forwarded_offset": total_forwarded,
           "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **kw}
    try:
        with open(EVENTS, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except OSError:
        pass
    print(f"[qrng-connector] {json.dumps(rec)}", file=sys.stderr, flush=True)


def forward(data: bytes) -> None:
    """Repassa só palavras completas; segura a cauda incompleta."""
    global _rem, total_forwarded
    buf = _rem + data
    keep = len(buf) - (len(buf) % WORD)
    _rem = buf[keep:]
    if keep:
        sys.stdout.buffer.write(buf[:keep])
        sys.stdout.buffer.flush()
        total_forwarded += keep


def main() -> None:
    global _rem
    backoff = RETRY_MIN
    first = True
    while True:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET,  socket.SO_KEEPALIVE,   1)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE,  10)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL,  5)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT,    3)
        s.settimeout(10)
        conn_bytes = 0
        try:
            s.connect((HOST, PORT))
            emit_event("connect" if first else "reconnect", backoff_s=backoff)
            first = False
            backoff = RETRY_MIN
            s.settimeout(60)
            # a cauda incompleta da conexão anterior NÃO é válida para a nova
            _rem = b""
            while True:
                data = s.recv(CHUNK)
                if not data:
                    print("[qrng-connector] EOF — FPGA fechou conexão", file=sys.stderr, flush=True)
                    break
                conn_bytes += len(data)
                forward(data)
        except Exception as e:
            print(f"[qrng-connector] erro: {e}", file=sys.stderr, flush=True)
        finally:
            try:
                s.close()
            except Exception:
                pass
        emit_event("disconnect", prev_conn_bytes=conn_bytes, held_partial=len(_rem))
        print(f"[qrng-connector] reconectando em {backoff}s...", file=sys.stderr, flush=True)
        time.sleep(backoff)
        backoff = min(backoff * 2, RETRY_MAX)


if __name__ == "__main__":
    main()
