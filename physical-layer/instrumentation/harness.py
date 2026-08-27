# -*- coding: utf-8 -*-
"""Harness de instrumentacao/replay da camada fisica (fase item 7).

Objetivo: comparar O MESMO BLOCO em cada fronteira acessivel do pipeline
        registrador/FIFO -> fifo.c -> socket TCP -> qrng-connector.py
        -> saida do connector -> server_api.py -> ring buffer
sem abrir um SEGUNDO consumidor concorrente da fonte e sem alterar o stream
produtivo. NADA aqui toca a FPGA/FIFO/conexao de producao -- so fixtures e
replay ate uma janela controlada ser autorizada.

Modelo:
  - Um "tap" recebe um bloco UMA vez, encaminha inalterado ("forward"), e
    copia para evidencia ("evidence") sem transformar.
  - Cada fronteira registra um BoundaryRecord (capture ID, sequencia, offsets,
    tamanho, SHA-256, timestamps monotonico+civil, hexdumps inicio/meio/fim,
    primeiro offset divergente vs a fronteira anterior, bytes esperado/observado).
  - `compare_across_boundaries()` produz a tabela de hashes por fronteira e o
    primeiro offset divergente, se houver.

Restricoes verificadas por teste (test_harness.py):
  - o bloco e lido UMA vez por fronteira (o tap nao re-le a fonte);
  - forward == entrada (sem reordenar, sem framing, sem descartar/duplicar);
  - a copia de evidencia == forward;
  - o produtor nao e bloqueado indefinidamente (o tap tem timeout).
"""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from typing import Callable, Optional


def _hexdump(b: bytes, start: int = 0, length: int = 16) -> str:
    chunk = b[start:start + length]
    return chunk.hex(" ")


def _hexdumps(b: bytes) -> dict:
    n = len(b)
    return {
        "head": _hexdump(b, 0, 16),
        "mid": _hexdump(b, max(0, n // 2 - 8), 16) if n >= 16 else "",
        "tail": _hexdump(b, max(0, n - 16), 16),
    }


def first_divergent_offset(a: bytes, b: bytes) -> int:
    """Primeiro offset onde a e b diferem; -1 se identicos ate min(len)."""
    m = min(len(a), len(b))
    for i in range(m):
        if a[i] != b[i]:
            return i
    if len(a) != len(b):
        return m
    return -1


@dataclass
class BoundaryRecord:
    capture_id: str
    boundary: str
    sequence: int
    offset_start: int
    offset_end: int
    n_bytes: int
    sha256: str
    ts_monotonic: float
    ts_civil: str
    hexdumps: dict
    first_divergent_vs_prev: Optional[int] = None
    expected_bytes_at_divergence: Optional[str] = None
    observed_bytes_at_divergence: Optional[str] = None

    def as_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class SingleReadTap:
    """Recebe um bloco UMA vez. `forward()` devolve o bloco inalterado;
    `evidence()` devolve uma copia identica. Levanta se `feed()` for chamado
    duas vezes (garante 'lido uma unica vez'). `read_timeout_s` limita a
    espera para nao bloquear o produtor indefinidamente."""
    read_timeout_s: float = 5.0
    _block: Optional[bytes] = field(default=None, repr=False)
    _consumed: bool = False

    def feed(self, block: bytes) -> None:
        if self._block is not None:
            raise RuntimeError("SingleReadTap.feed() chamado 2x -- o bloco deve ser lido UMA vez")
        self._block = bytes(block)

    def forward(self) -> bytes:
        if self._block is None:
            raise RuntimeError("forward() antes de feed()")
        self._consumed = True
        return self._block  # inalterado: sem reordenar/framing/descarte/duplicacao

    def evidence(self) -> bytes:
        if self._block is None:
            raise RuntimeError("evidence() antes de feed()")
        return bytes(self._block)  # copia identica, sem transformacao


class BoundaryCapture:
    """Acumula BoundaryRecords para um capture_id e compara fronteiras."""

    def __init__(self, capture_id: str):
        self.capture_id = capture_id
        self.records: list[BoundaryRecord] = []
        self._t0 = time.monotonic()
        self._blocks: dict = {}

    def record(self, boundary: str, block: bytes, sequence: int, offset_start: int) -> BoundaryRecord:
        prev = self.records[-1] if self.records else None
        rec = BoundaryRecord(
            capture_id=self.capture_id,
            boundary=boundary,
            sequence=sequence,
            offset_start=offset_start,
            offset_end=offset_start + len(block),
            n_bytes=len(block),
            sha256=hashlib.sha256(block).hexdigest(),
            ts_monotonic=round(time.monotonic() - self._t0, 6),
            ts_civil=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            hexdumps=_hexdumps(block),
        )
        if prev is not None:
            fdo = first_divergent_offset(self._blocks[prev.boundary], block)
            rec.first_divergent_vs_prev = fdo
            if fdo >= 0:
                a = self._blocks[prev.boundary]
                rec.expected_bytes_at_divergence = _hexdump(a, max(0, fdo - 4), 12)
                rec.observed_bytes_at_divergence = _hexdump(block, max(0, fdo - 4), 12)
        self.records.append(rec)
        self._blocks[boundary] = block
        return rec

    def hash_table(self) -> list[dict]:
        return [{"boundary": r.boundary, "n_bytes": r.n_bytes, "sha256": r.sha256,
                 "first_divergent_vs_prev": r.first_divergent_vs_prev} for r in self.records]

    def preserved(self) -> bool:
        """True se todas as fronteiras tem o MESMO sha256 (bloco preservado)."""
        if not self.records:
            return False
        h0 = self.records[0].sha256
        return all(r.sha256 == h0 for r in self.records)

    def first_boundary_with_divergence(self) -> Optional[dict]:
        for r in self.records[1:]:
            if r.first_divergent_vs_prev is not None and r.first_divergent_vs_prev >= 0:
                return r.as_dict()
        return None


# --- Modelos das fronteiras (para replay com fixtures) -----------------------
def identity_boundary(block: bytes) -> bytes:
    """connector + FIFO + /v1/raw de server_api.py: passthrough verbatim
    (confirmado lendo o codigo executado -- ver NOISE_SOURCE_UNIT.md)."""
    return bytes(block)


def ring_buffer_boundary(block: bytes, drop_prefix: int = 0) -> bytes:
    """server_api.py RingBuffer: copia verbatim, mas em overflow DESCARTA os
    bytes MAIS ANTIGOS. drop_prefix>0 simula um evento de drop -> o consumidor
    recebe um bloco que NAO e contiguo em relacao a saida do connector."""
    return bytes(block[drop_prefix:])


def run_replay(capture_id: str, source_block: bytes, *, ring_drop_prefix: int = 0) -> BoundaryCapture:
    """Passa `source_block` pelas fronteiras conhecidas (modelos acima) via
    SingleReadTap por fronteira. NAO abre segundo consumidor: cada fronteira
    recebe explicitamente o mesmo bloco uma vez."""
    cap = BoundaryCapture(capture_id)

    boundaries = [
        ("register_fifo_out", identity_boundary),
        ("fifo_c_out", identity_boundary),
        ("tcp_socket", identity_boundary),
        ("connector_in", identity_boundary),
        ("connector_out", identity_boundary),
        ("server_api_in", identity_boundary),
        ("ring_buffer", lambda b: ring_buffer_boundary(b, ring_drop_prefix)),
    ]
    cur = source_block
    offset = 0
    for seq, (name, fn) in enumerate(boundaries):
        tap = SingleReadTap()
        tap.feed(cur)
        fwd = tap.forward()
        ev = tap.evidence()
        assert ev == fwd, "copia de evidencia divergiu do forward"
        out = fn(fwd)
        cap.record(name, out, sequence=seq, offset_start=offset)
        cur = out
    return cap


if __name__ == "__main__":
    import json
    src = bytes((i * 37 + 11) & 0xFF for i in range(256))
    print("== replay IDENTICO ==")
    c = run_replay("cap-demo-identical", src)
    print(json.dumps(c.hash_table(), indent=1))
    print("preserved:", c.preserved(), "| first divergence:", c.first_boundary_with_divergence())
    print("\n== replay com DROP no ring buffer (fronteira fisica simulada) ==")
    c2 = run_replay("cap-demo-drop", src, ring_drop_prefix=4)
    print(json.dumps(c2.hash_table(), indent=1))
    print("preserved:", c2.preserved(), "| first divergence:", c2.first_boundary_with_divergence())
