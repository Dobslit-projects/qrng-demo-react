#!/usr/bin/env python3
"""QRNG Connector — versão STAGING (itens 2 e 4: trabalho por GERAÇÃO DE CONEXÃO).

**NÃO IMPLANTADO.** O que roda na dobslit é `qrng-connector.py` (baseline).

Contrato (item 4), para CADA conexão:
  1. cria `connection_generation` (monótono, +1 por conexão);
  2. acumula bytes num buffer residual (cauda de palavra incompleta, 0..3);
  3. encaminha SOMENTE palavras completas de 4 bytes;
  4. no EOF/erro, DESCARTA EXPLICITAMENTE a cauda de 1..3 bytes — nunca a
     concatena com a próxima conexão;
  5. registra no SIDEBAND JSONL (fora do stream): geração, total recebido, total
     encaminhado, bytes de cauda descartados, timestamp, motivo da desconexão;
  6. NÃO afirma conhecer os bytes perdidos DENTRO do TCP (só a cauda local, 0..3);
  7. NÃO insere metadata no stream binário.

`discarded_partial_bytes` ∈ {0,1,2,3}. Bytes possivelmente perdidos na rede
(entre o `nc` da FPGA e este connector) permanecem DESCONHECIDOS — nunca uma
quantidade.
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


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def emit(rec: dict) -> None:
    try:
        with open(EVENTS, "a") as f:
            f.write(json.dumps(rec) + "\n")
    except OSError:
        pass
    print(f"[qrng-connector] {json.dumps(rec)}", file=sys.stderr, flush=True)


class Connection:
    """Estado de UMA conexão. Nunca compartilha cauda com outra."""

    def __init__(self, generation: int, forwarded_offset_start: int):
        self.generation = generation
        self.received_bytes = 0
        self.forwarded_bytes = 0
        self._rem = b""                         # 0..3 bytes de cauda de palavra
        self.forwarded_offset_start = forwarded_offset_start

    def feed(self, data: bytes) -> bytes:
        """recebe bytes crus (partial reads ok) -> devolve só palavras completas."""
        self.received_bytes += len(data)
        buf = self._rem + data
        keep = len(buf) - (len(buf) % WORD)
        self._rem = buf[keep:]
        out = buf[:keep]
        self.forwarded_bytes += len(out)
        return out

    def close(self, reason: str) -> int:
        """descarta EXPLICITAMENTE a cauda; devolve quantos bytes (0..3)."""
        discarded = len(self._rem)
        self._rem = b""                          # nunca vai para a próxima conexão
        return discarded


def main() -> None:
    try:
        open(EVENTS, "w").close()               # trunca no arranque
    except OSError:
        pass

    generation = 0
    total_forwarded = 0                          # offset global (todas as gerações)
    backoff = RETRY_MIN

    while True:
        generation += 1
        conn = Connection(generation, total_forwarded)
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET,  socket.SO_KEEPALIVE,   1)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE,  10)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL,  5)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT,    3)
        s.settimeout(10)
        reason = "unknown"
        try:
            s.connect((HOST, PORT))
            emit({"event": "connect", "connection_generation": generation,
                  "forwarded_offset": total_forwarded, "backoff_s": backoff,
                  "observed_at": _now()})
            backoff = RETRY_MIN
            s.settimeout(60)
            while True:
                data = s.recv(CHUNK)
                if not data:
                    reason = "eof"
                    break
                out = conn.feed(data)
                if out:
                    sys.stdout.buffer.write(out)
                    sys.stdout.buffer.flush()
                    total_forwarded += len(out)
        except socket.timeout:
            reason = "timeout"
        except Exception as e:                   # noqa: BLE001
            reason = f"error:{type(e).__name__}"
            print(f"[qrng-connector] erro: {e}", file=sys.stderr, flush=True)
        finally:
            try:
                s.close()
            except Exception:
                pass

        discarded = conn.close(reason)
        emit({"event": "disconnect",
              "connection_generation": generation,
              "received_bytes": conn.received_bytes,
              "forwarded_bytes": conn.forwarded_bytes,
              "discarded_partial_bytes": discarded,   # SEMPRE 0..3
              "reason": reason,
              "observed_at": _now(),
              # bytes perdidos dentro do TCP: DESCONHECIDO, não quantificado
              "network_gap": "unknown"})
        print(f"[qrng-connector] gen={generation} reconectando em {backoff}s "
              f"(descartou {discarded} B de cauda)...", file=sys.stderr, flush=True)
        time.sleep(backoff)
        backoff = min(backoff * 2, RETRY_MAX)


if __name__ == "__main__":
    main()
