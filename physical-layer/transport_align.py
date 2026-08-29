# -*- coding: utf-8 -*-
"""Realinhamento de palavra + descontinuidade do transporte QRNG (itens 2 e 3).

Contexto (inspeção FPGA 2026-08-28, `FPGA_INSPECTION_RESULT.md`):
  `/root/fifo.c` escreve EXATAMENTE 4 bytes por palavra (`htole32` + `write(4)`).
  O `nc -k -l :12345` e o `qrng-connector.py` são passthrough de bytes. Numa
  RECONEXÃO do connector, os bytes que o `nc` já enviou mas o connector ainda
  não recebeu são PERDIDOS na rede — se a perda não for múltiplo de 4, todo o
  agrupamento uint32 a jusante fica **permanentemente desalinhado**, sem forma de
  detectar (não há número de sequência da FPGA).

Este módulo NÃO recupera bytes perdidos (impossível sem sync da FPGA). Ele:
  1. mantém um `stream_offset` monótono (bytes de palavra completa entregues);
  2. quando o connector sinaliza uma reconexão num offset N com `N % 4 != 0`,
     DESCARTA `(4 - N%4) % 4` bytes do próximo dado, "encaixando" o grid de
     palavra de novo (best-effort — custa 0–3 bytes);
  3. registra cada evento (`reconnect`, `realign`, `drop_oldest`) como
     `Discontinuity` num anel — exposto a jusante, NUNCA inserido no stream.

Nada aqui toca produção. Uso: staging / replay / testes.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field, asdict
from typing import Optional


WORD = 4


@dataclass
class Discontinuity:
    kind: str            # "reconnect" | "realign" | "drop_oldest"
    at_offset: int       # offset (no fluxo de saída alinhado) onde ocorreu
    bytes_dropped: int   # 0-3 (realign) | N (drop_oldest) | 0 (reconnect puro)
    ts_civil: str
    detail: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


class WordAligner:
    """Entra bytes crus do connector + eventos de reconexão; sai bytes garantidos
    alinhados a palavra de 4 bytes (só palavras completas), com o histórico de
    descontinuidades. `feed(data)` -> bytes prontos p/ o ring buffer.
    `note_reconnect(connector_forwarded_offset)` -> aplica o realinhamento."""

    def __init__(self, max_discont: int = 256):
        self._rem = b""              # 0-3 bytes de cauda de palavra incompleta
        self._pending_drop = 0       # bytes a descartar por realinhamento
        self.out_offset = 0          # bytes de palavra completa já entregues
        self.in_offset = 0           # bytes crus já recebidos
        self.discontinuities: list[Discontinuity] = []
        self._max_discont = max_discont
        self.realign_total = 0       # soma de bytes descartados por realinhamento
        self.reconnects = 0

    def _push_discont(self, d: Discontinuity) -> None:
        self.discontinuities.append(d)
        if len(self.discontinuities) > self._max_discont:
            self.discontinuities.pop(0)

    def note_reconnect(self, connector_forwarded_offset: int, backoff_s: float = 0.0) -> None:
        """O connector reconectou. Se ele já havia repassado um número de bytes
        não múltiplo de 4 quando caiu, o próximo dado começa no meio de uma
        palavra -> agenda o descarte de (4 - off%4)%4 bytes."""
        self.reconnects += 1
        off = connector_forwarded_offset
        misalign = off % WORD
        self._rem = b""              # cauda incompleta anterior não é mais válida
        drop = (WORD - misalign) % WORD
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._push_discont(Discontinuity(
            kind="reconnect", at_offset=self.out_offset, bytes_dropped=0, ts_civil=ts,
            detail=f"connector forwarded_offset={off} misalign={misalign} backoff={backoff_s}s"))
        if drop:
            self._pending_drop += drop
            self._push_discont(Discontinuity(
                kind="realign", at_offset=self.out_offset, bytes_dropped=drop, ts_civil=ts,
                detail=f"dropping {drop} byte(s) to snap uint32 grid"))

    def feed(self, data: bytes) -> bytes:
        self.in_offset += len(data)
        buf = self._rem + data
        self._rem = b""
        # aplica descarte de realinhamento pendente
        if self._pending_drop:
            d = min(self._pending_drop, len(buf))
            buf = buf[d:]
            self._pending_drop -= d
            self.realign_total += d
        # segura a cauda de palavra incompleta
        keep = len(buf) - (len(buf) % WORD)
        self._rem = buf[keep:]
        out = buf[:keep]
        self.out_offset += len(out)
        return out

    def note_drop_oldest(self, dropped: int) -> None:
        """O ring buffer descartou `dropped` bytes antigos (drop-oldest)."""
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._push_discont(Discontinuity(
            kind="drop_oldest", at_offset=self.out_offset, bytes_dropped=dropped,
            ts_civil=ts, detail="RingBuffer overflow — oldest bytes discarded"))

    def data_discontinuities(self) -> int:
        """Contagem de eventos que envolveram PERDA/DESCARTE de bytes: `realign`
        (bytes descartados p/ re-encaixar o grid) + `drop_oldest`. Uma reconexão
        que caiu numa borda de palavra (misalign 0) é registrada para auditoria
        mas NÃO conta aqui — um restart limpo do connector/server_api não deve
        marcar o buffer como descontínuo para sempre."""
        return sum(1 for d in self.discontinuities if d.kind in ("realign", "drop_oldest"))

    # ---- estado p/ /health e headers ----
    def state(self) -> dict:
        return {
            "stream_offset": self.out_offset,          # bytes de palavra completa entregues
            "raw_offset": self.in_offset,              # bytes crus recebidos
            "word_aligned": self._rem == b"" and self._pending_drop == 0,
            "pending_realign_bytes": self._pending_drop,
            "held_partial_bytes": len(self._rem),
            "reconnects": self.reconnects,
            "realign_bytes_total": self.realign_total,
            "discontinuities": self.data_discontinuities(),        # só perda de bytes
            "events_total": len(self.discontinuities),             # incl. reconnects limpos
            "last_discontinuity": self.discontinuities[-1].as_dict() if self.discontinuities else None,
        }

    def discontinuous(self) -> bool:
        """True se HOUVE realign ou drop_oldest — o consumidor deve tratar os
        blocos como possivelmente NÃO contíguos. Reconexão em borda de palavra
        (sem perda além do que sumiu na rede, múltiplo de 4) não conta."""
        return self.data_discontinuities() > 0


# --------- leitor do sideband do connector (item 2) ----------
def parse_connector_events(text: str) -> list:
    """Lê o JSONL de eventos do connector: {"event":"connect|reconnect",
    "forwarded_offset":N,"ts":...,"backoff_s":B}."""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


if __name__ == "__main__":            # pragma: no cover
    a = WordAligner()
    # 10 palavras
    src = b"".join(i.to_bytes(4, "little") for i in range(10))
    print("out:", a.feed(src[:14]).hex())          # 3 palavras + 2 bytes segurados
    a.note_reconnect(connector_forwarded_offset=14)  # 14 % 4 = 2 -> descarta 2
    print("after reconnect, feed rest:", a.feed(src[14:]).hex())
    print("state:", json.dumps(a.state(), indent=1))
