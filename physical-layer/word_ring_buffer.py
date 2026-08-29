# -*- coding: utf-8 -*-
"""Ring buffer com FRONTEIRAS DE PALAVRA preservadas + offset absoluto + geração
(itens 5, 6, 7).

Contexto (`FPGA_INSPECTION_RESULT.md`): `/root/fifo.c` escreve EXATAMENTE 4 bytes
por palavra (`num = *(RDFD); le = htole32(num); write_all(&le, 4)`). A
propriedade obrigatória (item 3/5):

    Toda palavra entregue pelo endpoint /v1/uint32 deve corresponder EXATAMENTE
    a uma palavra completa produzida pelo fifo.c. Nenhuma palavra pode combinar
    bytes de duas palavras físicas diferentes ou de duas conexões diferentes.

## Opção A (implementada aqui)

* Armazena internamente UNIDADES DE 4 BYTES (uma palavra por slot).
* `head`, `tail`, `size` e `drop_oldest` avançam sempre em múltiplos de 4.
* Um pedido de `N` bytes consome `ceil(N/4)` palavras, devolve exatamente `N`
  bytes e DESCARTA explicitamente os `0..3` bytes restantes da última palavra
  (`alignment_discarded_bytes`). O próximo pedido começa em nova fronteira de
  palavra.
* Um pedido Raw de 1 byte NÃO desalinha pedidos `/v1/uint32` posteriores.

## Offset absoluto e geração (item 6)

`source_session_id` muda a cada reload de bitstream / restart do produtor / perda
de continuidade. `source_offset_bytes` é o total de bytes que ENTRARAM
(entregues + descartados por alinhamento + descartados por drop-oldest +
descartados no fim de conexão). Bytes perdidos ANTES de chegar ao connector
(dentro do TCP) são `unknown_gap=true`, nunca uma quantidade.

## Metadata por segmento (item 7)

Cada `push` grava, junto ao segmento de palavras, `received_first_at`,
`received_last_at`, `source_session_id`, `connection_generation`,
`discontinuity_before`. Uma resposta reporta o intervalo real de recepção dos
seus bytes — NÃO o `last_push_time` global.

NADA aqui toca produção. Uso: staging / replay / testes.
"""
from __future__ import annotations

import math
import struct
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

WORD = 4


@dataclass
class Segment:
    """Um bloco de palavras contíguas empurrado numa única operação."""
    start_word: int                 # índice de palavra absoluto (nesta sessão) do 1º
    n_words: int
    received_first_at: float        # epoch do 1º byte recebido
    received_last_at: float
    source_session_id: str
    connection_generation: int
    discontinuity_before: str       # "none" | "drop_oldest" | "realign" | "unknown_gap" | "session_change"


@dataclass
class ResponseMeta:
    n_bytes: int
    word_start_offset: int          # offset absoluto em BYTES da 1ª palavra servida
    word_end_offset: int            # offset absoluto em BYTES logo após a última palavra servida
    response_start_offset: int      # == word_start_offset
    response_end_offset: int        # == word_start_offset + n_bytes (bytes realmente entregues)
    alignment_discarded_bytes: int  # 0..3 (cauda da última palavra não entregue)
    received_first_at: float
    received_last_at: float
    source_session_id: str
    connection_generation: int
    unknown_gap_before: bool
    discontinuity_before: str
    sha256_hex: str = ""

    def headers(self) -> dict:
        from datetime import datetime, timezone
        def iso(t): return datetime.fromtimestamp(t, tz=timezone.utc).isoformat() if t else ""
        return {
            "X-QRNG-Received-First-At": iso(self.received_first_at),
            "X-QRNG-Received-Last-At": iso(self.received_last_at),
            "X-QRNG-Source-Session-Id": self.source_session_id,
            "X-QRNG-Connection-Generation": str(self.connection_generation),
            "X-QRNG-Response-Start-Offset": str(self.response_start_offset),
            "X-QRNG-Response-End-Offset": str(self.response_end_offset),
            "X-QRNG-Unknown-Gap-Before": "true" if self.unknown_gap_before else "false",
            "X-QRNG-Alignment-Discarded-Bytes": str(self.alignment_discarded_bytes),
            "X-QRNG-Discontinuity-Before": self.discontinuity_before,
        }


class WordRingBuffer:
    """Buffer de palavras de 4 bytes, drop-oldest em unidades de palavra."""

    def __init__(self, capacity_words: int, session_id: Optional[str] = None):
        self.cap_words = capacity_words
        self.words: list[bytes] = []          # deque simples; cada elemento = 4 bytes
        self.lock = threading.Lock()
        self.not_empty = threading.Condition(self.lock)
        # offsets absolutos (BYTES) nesta sessão
        self.source_offset_bytes = 0          # total de bytes que ENTRARAM (todas as origens)
        self.delivered_bytes = 0
        self.alignment_discarded_total = 0
        self.dropped_oldest_bytes = 0
        self.conn_end_discarded_bytes = 0
        self.words_in = 0                     # palavras completas que entraram
        self.words_out = 0                    # palavras consumidas (entregues OU descartadas por alinhamento)
        self.buffer_tail_word = 0             # índice de palavra absoluto do 1º ainda no buffer
        self.source_session_id = session_id or ("sess_" + uuid.uuid4().hex[:12])
        self.connection_generation = 0
        self._segments: list[Segment] = []   # metadata paralela às palavras (mesmo comprimento lógico)
        self._pending_discontinuity = "none"  # marca o próximo push

    # ---- ciclo de vida da sessão / geração (item 6) ----
    def new_session(self, reason: str = "producer_restart") -> str:
        with self.lock:
            self.source_session_id = "sess_" + uuid.uuid4().hex[:12]
            self.connection_generation = 0
            self._pending_discontinuity = "session_change"
        return self.source_session_id

    def new_connection_generation(self, discontinuity: str = "realign") -> int:
        """Chamar quando o connector reconectar. `discontinuity` descreve o que
        aconteceu na fronteira: 'realign' (perda não múltipla de 4, grid
        re-encaixado a montante), 'unknown_gap' (perda desconhecida no TCP),
        'none' (reconexão em borda de palavra sem perda observável)."""
        with self.lock:
            self.connection_generation += 1
            if discontinuity != "none":
                self._pending_discontinuity = discontinuity
        return self.connection_generation

    def mark_unknown_gap(self):
        with self.lock:
            self._pending_discontinuity = "unknown_gap"

    # ---- produção ----
    def push_words(self, data: bytes, received_first_at: Optional[float] = None,
                   received_last_at: Optional[float] = None) -> int:
        """`data` DEVE ser múltiplo de 4 (o connector já garante — item 4).
        Levanta se não for: fronteira de palavra é invariante do produtor."""
        if len(data) % WORD != 0:
            raise ValueError(f"push_words exige múltiplo de 4, recebeu {len(data)}")
        now = time.time()
        rf = received_first_at if received_first_at is not None else now
        rl = received_last_at if received_last_at is not None else now
        n = len(data) // WORD
        with self.not_empty:
            self.source_offset_bytes += len(data)
            seg = Segment(start_word=self.words_in, n_words=n,
                          received_first_at=rf, received_last_at=rl,
                          source_session_id=self.source_session_id,
                          connection_generation=self.connection_generation,
                          discontinuity_before=self._pending_discontinuity)
            self._pending_discontinuity = "none"
            for i in range(n):
                self.words.append(data[i * WORD:(i + 1) * WORD])
                self._segments.append(seg)
            self.words_in += n
            # drop-oldest em unidades de palavra
            while len(self.words) > self.cap_words:
                self.words.pop(0)
                self._segments.pop(0)
                self.buffer_tail_word += 1
                self.dropped_oldest_bytes += WORD
            self.not_empty.notify_all()
            return n

    # ---- consumo (item 5: devolve N bytes, descarta cauda, offset absoluto) ----
    def pop_bytes(self, n_bytes: int, timeout: float = 2.0) -> Optional[tuple]:
        """Devolve (data:bytes de tamanho n_bytes, ResponseMeta) ou None (timeout).
        Consome ceil(n_bytes/4) palavras; descarta os 0..3 bytes finais."""
        need_words = max(1, math.ceil(n_bytes / WORD))
        deadline = time.time() + timeout
        with self.not_empty:
            while len(self.words) < need_words:
                rem = deadline - time.time()
                if rem <= 0:
                    return None
                self.not_empty.wait(timeout=rem)
            first_word_abs = self.buffer_tail_word
            taken = self.words[:need_words]
            segs = self._segments[:need_words]
            del self.words[:need_words]
            del self._segments[:need_words]
            self.buffer_tail_word += need_words
            self.words_out += need_words

            blob = b"".join(taken)
            data = blob[:n_bytes]
            discarded = len(blob) - n_bytes                 # 0..3
            self.alignment_discarded_total += discarded
            self.delivered_bytes += n_bytes

            word_start_off = first_word_abs * WORD
            # descontinuidade "antes" = a do 1º segmento servido (ou drop-oldest se
            # o tail avançou por drop desde o último pop — capturado via segmento)
            disc = segs[0].discontinuity_before
            # se qualquer segmento no meio deste pop tem descontinuidade, é a mais grave
            order = {"none": 0, "drop_oldest": 1, "session_change": 2, "realign": 3, "unknown_gap": 4}
            worst = max(segs, key=lambda s: order.get(s.discontinuity_before, 0)).discontinuity_before
            if order.get(worst, 0) > order.get(disc, 0):
                disc = worst
            unknown_gap = any(s.discontinuity_before == "unknown_gap" for s in segs)

            import hashlib
            meta = ResponseMeta(
                n_bytes=n_bytes,
                word_start_offset=word_start_off,
                word_end_offset=word_start_off + need_words * WORD,
                response_start_offset=word_start_off,
                response_end_offset=word_start_off + n_bytes,
                alignment_discarded_bytes=discarded,
                received_first_at=min(s.received_first_at for s in segs),
                received_last_at=max(s.received_last_at for s in segs),
                source_session_id=segs[-1].source_session_id,
                connection_generation=segs[-1].connection_generation,
                unknown_gap_before=unknown_gap,
                discontinuity_before=disc,
                sha256_hex=hashlib.sha256(data).hexdigest(),
            )
            return data, meta

    # ---- estado p/ /health ----
    def state(self) -> dict:
        with self.lock:
            return {
                "source_session_id": self.source_session_id,
                "connection_generation": self.connection_generation,
                "capacity_words": self.cap_words,
                "words_buffered": len(self.words),
                "words_in": self.words_in,
                "words_out": self.words_out,
                "source_offset_bytes": self.source_offset_bytes,
                "delivered_bytes": self.delivered_bytes,
                "buffer_tail_source_offset": self.buffer_tail_word * WORD,
                "alignment_discarded_total": self.alignment_discarded_total,
                "dropped_oldest_bytes": self.dropped_oldest_bytes,
                "conn_end_discarded_bytes": self.conn_end_discarded_bytes,
            }


def unpack_le(b: bytes) -> list:
    assert len(b) % 4 == 0
    return list(struct.unpack(f"<{len(b) // 4}I", b))


if __name__ == "__main__":                      # pragma: no cover
    rb = WordRingBuffer(capacity_words=1000)
    src = b"".join(struct.pack("<I", i) for i in range(100))
    rb.push_words(src)
    d, m = rb.pop_bytes(10)                      # 3 palavras -> 10 bytes, descarta 2
    print("bytes", d.hex(), "discarded", m.alignment_discarded_bytes)
    d2, m2 = rb.pop_bytes(8)                     # começa em NOVA fronteira de palavra
    print("uint32", unpack_le(d2), "start_off", m2.response_start_offset)
    print("state", rb.state())
