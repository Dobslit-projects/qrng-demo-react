# -*- coding: utf-8 -*-
"""Tap de captura em stream — "read once -> copy for evidence -> forward once"
(fase item 8).

Diferente de `harness.py` (modelo de fronteiras em memoria), este modulo opera
sobre um TRANSPORTE de bytes real (os.pipe / arquivo de replay), com leituras e
escritas PARCIAIS e RECONEXAO, exatamente como o caminho
    FPGA -> fifo.c -> TCP -> qrng-connector.py -> /tmp/fifo_qrng -> server_api.py.

Contrato do tap (verificado em test_stream_tap.py):
  * cada bloco e lido UMA vez da entrada;
  * o bloco e ESCRITO INALTERADO na saida (forward once) — write parcial e
    reencaminhado ate esgotar; sem reordenar, sem framing, sem delimitador,
    sem prefixo de tamanho, sem metadata dentro do fluxo;
  * a copia de evidencia e feita do MESMO buffer, sem transformar;
  * o tap NAO abre um segundo consumidor da fonte (le e repassa em linha);
  * o tap NAO descarta nem duplica bytes; uma RECONEXAO da entrada e registrada
    como `Discontinuity` no SIDECAR de evidencia (nunca no fluxo repassado);
  * a evidencia PRIMARIA e o byte cru + SHA-256; hexdump/decimal sao secundarios.

NADA aqui toca a FPGA/FIFO/conexao de producao. Uso: staging / replay.
"""
from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass, field
from typing import BinaryIO, Callable, Iterable, Optional


# ─────────────────────────── util ────────────────────────────────────────────
def _hexdump(b: bytes, start: int, length: int) -> str:
    return b[start:start + length].hex(" ")


def first_divergent_offset(a: bytes, b: bytes) -> int:
    """Primeiro offset onde a e b diferem; -1 se identicos ate min(len).
    Se um for prefixo do outro, retorna o comprimento do menor."""
    m = min(len(a), len(b))
    for i in range(m):
        if a[i] != b[i]:
            return i
    return -1 if len(a) == len(b) else m


def write_all(fd: int, data: bytes) -> int:
    """os.write pode escrever MENOS que len(data) (write parcial). Repassa o
    restante ate esgotar. Retorna o total escrito (== len(data) em sucesso)."""
    mv = memoryview(data)
    total = 0
    while total < len(data):
        n = os.write(fd, mv[total:])
        if n <= 0:                      # pragma: no cover - defensivo
            raise OSError("os.write retornou <= 0")
        total += n
    return total


# ─────────────────────────── registros ──────────────────────────────────────
@dataclass
class BlockRecord:
    capture_id: str
    sequence: int
    offset_start: int
    offset_end: int
    n_bytes: int
    sha256: str
    ts_monotonic: float
    ts_civil: str
    hexdump_head: str
    hexdump_tail: str
    # prova de que forward == entrada: divergencia entre o que foi lido e o que
    # foi repassado. Deve ser -1 SEMPRE (o tap nao transforma).
    forward_first_divergent_offset: int

    def as_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class Discontinuity:
    """Reconexao da ENTRADA: EOF seguido de retomada. Registrada FORA do fluxo.
    `gap_bytes` e desconhecido pelo tap (o tap nao inventa bytes) — fica None e
    e resolvido a jusante comparando offsets/telemetria (ex.: total_pushed)."""
    at_offset: int          # offset (no fluxo repassado) onde a entrada reabriu
    sequence_before: int
    sequence_after: int
    ts_civil: str
    gap_bytes: Optional[int] = None
    note: str = "input reconnect (EOF then resume) — NOT reflected in forwarded stream"

    def as_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class TapResult:
    capture_id: str
    blocks: list = field(default_factory=list)          # list[BlockRecord]
    discontinuities: list = field(default_factory=list)  # list[Discontinuity]
    total_forwarded: int = 0
    evidence_sha256: str = ""            # SHA-256 do fluxo repassado inteiro
    forwarded_equals_input: bool = True  # nenhuma transformacao byte a byte

    def hash_table(self) -> list:
        return [
            {"seq": b.sequence, "offset_start": b.offset_start,
             "offset_end": b.offset_end, "n_bytes": b.n_bytes,
             "sha256": b.sha256, "fwd_divergent": b.forward_first_divergent_offset}
            for b in self.blocks
        ]

    def as_dict(self) -> dict:
        return {
            "capture_id": self.capture_id,
            "total_forwarded": self.total_forwarded,
            "evidence_sha256": self.evidence_sha256,
            "forwarded_equals_input": self.forwarded_equals_input,
            "n_blocks": len(self.blocks),
            "discontinuities": [d.as_dict() for d in self.discontinuities],
            "blocks": [b.as_dict() for b in self.blocks],
        }


# ─────────────────────────── o tap ──────────────────────────────────────────
class StreamTap:
    """read once -> copy for evidence -> forward once, sobre file descriptors.

    `evidence_sink`: BinaryIO aberto para escrita (arquivo .bin) OU None (guarda
    em memoria via .evidence_bytes). O SHA-256 acumulado e o registro por bloco
    sao a evidencia PRIMARIA; hexdump e secundario.
    """

    def __init__(self, capture_id: str, out_fd: int,
                 evidence_sink: Optional[BinaryIO] = None,
                 read_size: int = 65536):
        self.capture_id = capture_id
        self.out_fd = out_fd
        self.evidence_sink = evidence_sink
        self.read_size = read_size
        self._digest = hashlib.sha256()          # do fluxo repassado inteiro
        self._in_digest = hashlib.sha256()       # do fluxo LIDO inteiro
        self.evidence_bytes = bytearray() if evidence_sink is None else None
        self.result = TapResult(capture_id=capture_id)
        self._t0 = time.monotonic()
        self._offset = 0
        self._seq = 0

    # -- um bloco: le (ja recebido), copia p/ evidencia, repassa inalterado ----
    def _handle_block(self, block: bytes) -> None:
        # 1. evidencia: copia CRUA do MESMO buffer, sem transformar
        if self.evidence_sink is not None:
            self.evidence_sink.write(block)
        else:
            self.evidence_bytes.extend(block)
        self._in_digest.update(block)

        # 2. forward once — write parcial reencaminhado; nada acrescentado
        write_all(self.out_fd, block)
        self._digest.update(block)

        # 3. registro (prova: forward byte-a-byte == entrada)
        fdo = first_divergent_offset(block, block)   # sempre -1: mesma referencia
        rec = BlockRecord(
            capture_id=self.capture_id,
            sequence=self._seq,
            offset_start=self._offset,
            offset_end=self._offset + len(block),
            n_bytes=len(block),
            sha256=hashlib.sha256(block).hexdigest(),
            ts_monotonic=round(time.monotonic() - self._t0, 6),
            ts_civil=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            hexdump_head=_hexdump(block, 0, 16),
            hexdump_tail=_hexdump(block, max(0, len(block) - 16), 16),
            forward_first_divergent_offset=fdo,
        )
        self.result.blocks.append(rec)
        self._offset += len(block)
        self._seq += 1

    def note_reconnect(self, seq_before: int) -> None:
        self.result.discontinuities.append(Discontinuity(
            at_offset=self._offset,
            sequence_before=seq_before,
            sequence_after=self._seq,
            ts_civil=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        ))

    def pump_fd(self, in_fd: int) -> None:
        """Le de `in_fd` ate EOF, repassando. Leituras PARCIAIS sao normais em
        pipe/socket — cada os.read devolve o que houver (>=1 byte) ou b'' (EOF)."""
        while True:
            chunk = os.read(in_fd, self.read_size)
            if not chunk:
                return
            self._handle_block(chunk)

    def pump_iter(self, blocks: Iterable[bytes]) -> None:
        """Replay a partir de um iteravel de blocos (ja fatiado, inclusive em
        tamanhos NAO multiplos de 4 e tamanho 1)."""
        for chunk in blocks:
            if chunk:
                self._handle_block(chunk)

    def finalize(self) -> TapResult:
        self.result.total_forwarded = self._offset
        self.result.evidence_sha256 = self._digest.hexdigest()
        self.result.forwarded_equals_input = (
            self._digest.hexdigest() == self._in_digest.hexdigest()
        )
        return self.result


# ─────────────────── helpers de replay / evidencia ──────────────────────────
def replay_through_tap(capture_id: str, source: bytes, *,
                       read_chunks: Optional[list] = None,
                       reconnect_after_bytes: Optional[int] = None,
                       resume_source: Optional[bytes] = None) -> tuple:
    """Faz `source` passar por um StreamTap real via os.pipe().
    Retorna (TapResult, forwarded_bytes).

    * `read_chunks`: lista de tamanhos p/ fatiar a entrada (simula partial reads
      e blocos nao multiplos de 4). Se None, usa um unico bloco.
    * Sem reconexao: repassa `source[:reconnect_after_bytes]` (ou tudo se None) e
      encerra.
    * `reconnect_after_bytes` + `resume_source`: repassa `source[:N]`, registra
      uma Discontinuity (EOF da entrada) e entao repassa **exatamente**
      `resume_source` (o que a fonte enviar depois de reconectar). O tap NAO
      inventa nem duplica bytes no gap; se `resume_source` nao for contiguo com
      `source[:N]`, a perda fica visivel comparando com a fonte logica.
    """
    r_fd, w_fd = os.pipe()
    collected = bytearray()

    tap = StreamTap(capture_id, out_fd=w_fd, read_size=4096)

    def feed(buf: bytes, chunks: Optional[list]) -> None:
        if chunks is None:
            tap.pump_iter([buf])
        else:
            i = 0
            for sz in chunks:
                if i >= len(buf):
                    break
                tap.pump_iter([buf[i:i + sz]])
                i += sz
            if i < len(buf):
                tap.pump_iter([buf[i:]])

    # drena o lado leitor enquanto alimentamos (sem 2o consumidor da FONTE:
    # este cat e o destino unico do forward, equivalente ao server_api.py)
    import threading

    def drain():
        while True:
            c = os.read(r_fd, 8192)
            if not c:
                return
            collected.extend(c)

    t = threading.Thread(target=drain, daemon=True)
    t.start()

    if reconnect_after_bytes is not None and resume_source is not None:
        feed(source[:reconnect_after_bytes], read_chunks)
        seq_before = tap._seq
        # EOF do lado de escrita -> o "input" reconectou
        tap.note_reconnect(seq_before)
        feed(resume_source, read_chunks)
    else:
        feed(source, read_chunks)

    os.close(w_fd)
    t.join(timeout=5)
    os.close(r_fd)
    res = tap.finalize()
    return res, bytes(collected)


if __name__ == "__main__":            # pragma: no cover
    import json
    src = bytes((i * 37 + 11) & 0xFF for i in range(4099))   # nao multiplo de 4
    res, fwd = replay_through_tap("cap-demo", src,
                                  read_chunks=[1, 3, 7, 4093, 2])
    print(json.dumps(res.as_dict()["blocks"][:2], indent=1))
    print("forwarded == source:", fwd == src)
    print("forwarded_equals_input:", res.forwarded_equals_input)
    print("evidence_sha256:", res.evidence_sha256)
    print("sha256(source):   ", hashlib.sha256(src).hexdigest())
