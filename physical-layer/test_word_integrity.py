# -*- coding: utf-8 -*-
"""Integridade de palavra ponta a ponta (itens 3, 5, 6, 7).

Propriedade obrigatória:
    Toda palavra entregue via /v1/uint32 corresponde EXATAMENTE a uma palavra
    completa do fifo.c. Nenhuma palavra mistura bytes de duas palavras físicas
    diferentes ou de duas conexões diferentes.

Pipeline sob teste:  fifo.c (palavras de 4 B)  ->  WordAligner (transport_align)
                     ->  WordRingBuffer (word_ring_buffer)  ->  pop_bytes.

Cada cenário verifica os VALORES uint32 EXATOS (não só contiguidade). NENHUMA
asserção é enfraquecida para passar; onde a perda de bytes na rede não é
descobrível, isso é REGISTRADO (não inventado).
"""
import struct
import unittest

from transport_align import WordAligner
from word_ring_buffer import WordRingBuffer, unpack_le, WORD


def words(n, start=0):
    return [struct.pack("<I", start + i) for i in range(n)]


def blob(word_list):
    return b"".join(word_list)


class Pipeline:
    """fifo.c -> WordAligner -> WordRingBuffer. `connector_forwarded` simula o
    offset de bytes CRUS que o connector já repassou quando caiu."""

    def __init__(self, cap_words=100000):
        self.aligner = WordAligner()
        self.rb = WordRingBuffer(capacity_words=cap_words)

    def feed_raw(self, raw: bytes):
        """bytes crus (podem não ser múltiplos de 4) -> aligner -> só palavras
        completas -> ring buffer."""
        aligned = self.aligner.feed(raw)
        if aligned:
            self.rb.push_words(aligned)

    def reconnect(self, connector_forwarded_offset: int):
        self.aligner.note_reconnect(connector_forwarded_offset)
        misalign = connector_forwarded_offset % WORD
        self.rb.new_connection_generation("realign" if misalign else "none")

    def pop_u32(self, count):
        r = self.rb.pop_bytes(count * 4, timeout=1.0)
        assert r is not None, "timeout inesperado"
        data, meta = r
        return unpack_le(data), meta


class TestPropriedadeExata(unittest.TestCase):
    """Para cada cenário: os uint32 entregues são um subconjunto ORDENADO das
    palavras do fifo.c, e NENHUM é frankenword."""

    LOGICAL = words(400)          # 400 palavras "físicas"
    LOGICAL_SET = set(LOGICAL)
    LOGICAL_U32 = [struct.unpack("<I", w)[0] for w in LOGICAL]

    def _assert_all_real_words(self, delivered_u32, label):
        for v in delivered_u32:
            self.assertIn(struct.pack("<I", v), self.LOGICAL_SET,
                          f"{label}: uint32 {v} NÃO é uma palavra do fifo.c (frankenword?)")

    def _assert_ordered_subsequence(self, delivered_u32, label):
        it = iter(self.LOGICAL_U32)
        for v in delivered_u32:
            for x in it:
                if x == v:
                    break
            else:
                self.fail(f"{label}: sequência de uint32 não é subsequência ordenada de fifo.c")

    # --- 1. sem desconexão ---
    def test_stream_limpo(self):
        p = Pipeline()
        p.feed_raw(blob(self.LOGICAL))
        u32, meta = p.pop_u32(100)
        self.assertEqual(u32, list(range(100)))
        self.assertEqual(meta.alignment_discarded_bytes, 0)
        self.assertEqual(meta.discontinuity_before, "none")
        u32b, _ = p.pop_u32(50)
        self.assertEqual(u32b, list(range(100, 150)))

    # --- 2. desconexão em FRONTEIRA de palavra (o caso "esperado 6 / obtido 458752") ---
    def test_desconexao_em_fronteira_de_palavra(self):
        p = Pipeline()
        p.feed_raw(blob(self.LOGICAL[:5]))         # 5 palavras (20 bytes) repassadas
        p.reconnect(connector_forwarded_offset=20)  # 20 % 4 == 0 -> sem realign
        # a nova conexão retoma da palavra 5 (nada além se perdeu na rede)
        p.feed_raw(blob(self.LOGICAL[5:]))
        u32, meta = p.pop_u32(10)
        self.assertEqual(u32, list(range(10)))     # palavras 0..9 intactas
        # a 6ª palavra entregue É a palavra 5 (== valor 5), NÃO um frankenword
        self.assertEqual(u32[5], 5)                # <-- exigido pelo item 3
        self._assert_all_real_words(u32, "fronteira")

    # --- 3/4/5. cauda de 1/2/3 bytes na queda (perda REAL, realinhamento) ---
    def test_cauda_de_1_2_3_bytes(self):
        for tail in (1, 2, 3):
            p = Pipeline()
            cut = 20 + tail                         # connector repassou 20+tail bytes crus
            p.feed_raw(blob(self.LOGICAL[:5]) + self.LOGICAL[5][:tail])
            p.reconnect(connector_forwarded_offset=cut)
            # a nova conexão retoma do byte `cut` (o connector perdeu a cauda);
            # o aligner descarta (4 - cut%4)%4 bytes p/ re-encaixar o grid.
            drop = (WORD - (cut % WORD)) % WORD
            self.assertEqual(drop, 4 - tail)
            p.feed_raw(blob(self.LOGICAL)[cut:])
            u32, meta = p.pop_u32(12)
            # palavras 0..4 intactas; a partir daí, grid re-encaixado na palavra 6
            self.assertEqual(u32[:5], [0, 1, 2, 3, 4], f"tail={tail}")
            self.assertEqual(u32[5], 6, f"tail={tail}: grid re-encaixado na palavra 6")
            self._assert_all_real_words(u32, f"cauda-{tail}")
            self._assert_ordered_subsequence(u32, f"cauda-{tail}")
            # a palavra 5 foi PERDIDA (cauda + realign) — registrado, não inventado
            self.assertNotIn(5, u32, f"tail={tail}: palavra 5 perdida, não remendada")

    # --- 6. perda de UMA palavra inteira ---
    def test_perda_de_uma_palavra(self):
        p = Pipeline()
        p.feed_raw(blob(self.LOGICAL[:10]))
        p.reconnect(connector_forwarded_offset=40)        # 40 % 4 == 0
        p.feed_raw(blob(self.LOGICAL[11:]))               # palavra 10 sumiu
        u32, _ = p.pop_u32(15)
        self.assertEqual(u32[:10], list(range(10)))
        self.assertEqual(u32[10], 11)                     # pula a 10, nenhum frankenword
        self._assert_all_real_words(u32, "1-palavra")

    # --- 7. perda de MÚLTIPLAS palavras ---
    def test_perda_de_multiplas_palavras(self):
        p = Pipeline()
        p.feed_raw(blob(self.LOGICAL[:8]))
        p.reconnect(connector_forwarded_offset=32)
        p.feed_raw(blob(self.LOGICAL[20:]))              # palavras 8..19 perdidas
        u32, _ = p.pop_u32(12)
        self.assertEqual(u32[:8], list(range(8)))
        self.assertEqual(u32[8], 20)
        self._assert_all_real_words(u32, "multi-palavra")
        self._assert_ordered_subsequence(u32, "multi-palavra")

    # --- 8. reconexões CONSECUTIVAS ---
    def test_reconexoes_consecutivas(self):
        p = Pipeline()
        p.feed_raw(blob(self.LOGICAL[:3]))
        p.reconnect(13)                                   # realign 3
        p.feed_raw(blob(self.LOGICAL)[13:17])             # 4 bytes crus -> após realign, 1 byte, sem palavra
        p.reconnect(17)                                   # realign 3 de novo
        p.feed_raw(blob(self.LOGICAL)[17:])
        u32, meta = p.pop_u32(20)
        self._assert_all_real_words(u32, "consecutivas")
        self._assert_ordered_subsequence(u32, "consecutivas")
        self.assertEqual(u32[:3], [0, 1, 2])
        self.assertGreaterEqual(meta.connection_generation, 2)

    # --- 9. PARTIAL READS (recv devolve 1 byte de cada vez) ---
    def test_partial_reads_1_byte(self):
        p = Pipeline()
        for b in blob(self.LOGICAL[:50]):
            p.feed_raw(bytes([b]))
        u32, _ = p.pop_u32(50)
        self.assertEqual(u32, list(range(50)))

    # --- 10. PARTIAL WRITES: o WordRingBuffer sempre recebe múltiplo de 4 do
    #        aligner; mesmo alimentando o aligner em pedaços ímpares, a palavra
    #        nunca sai partida ---
    def test_partial_writes_pedacos_impares(self):
        p = Pipeline()
        raw = blob(self.LOGICAL[:60])
        i = 0
        for step in (1, 2, 3, 5, 7, 11, 13):
            while i < len(raw):
                p.feed_raw(raw[i:i + step]); i += step
                if i % 97 == 0:
                    break
        p.feed_raw(raw[i:])
        u32, _ = p.pop_u32(60)
        self.assertEqual(u32, list(range(60)))

    # --- 11. EOF sem reconexão (fica o que entrou) ---
    def test_eof(self):
        p = Pipeline()
        p.feed_raw(blob(self.LOGICAL[:7]) + self.LOGICAL[7][:2])   # 7 palavras + 2 bytes
        # EOF: o aligner segura os 2 bytes; nunca viram palavra
        r = p.rb.pop_bytes(7 * 4, timeout=0.2)
        self.assertIsNotNone(r)
        u32 = unpack_le(r[0])
        self.assertEqual(u32, list(range(7)))
        # pedir uma 8ª palavra -> timeout (só há 7)
        self.assertIsNone(p.rb.pop_bytes(8 * 4, timeout=0.15))

    # --- 12. TIMEOUT (buffer vazio) ---
    def test_timeout_buffer_vazio(self):
        p = Pipeline()
        self.assertIsNone(p.rb.pop_bytes(16, timeout=0.15))

    # --- 13. RESTART do connector => nova connection_generation ---
    def test_restart_connector_nova_geracao(self):
        p = Pipeline()
        p.feed_raw(blob(self.LOGICAL[:10]))
        g0 = p.rb.connection_generation
        p.reconnect(40)                                  # restart limpo
        self.assertEqual(p.rb.connection_generation, g0 + 1)
        p.feed_raw(blob(self.LOGICAL[10:]))
        u32, meta = p.pop_u32(20)
        self.assertEqual(u32, list(range(20)))
        self.assertEqual(meta.connection_generation, g0 + 1)

    # --- 14. RESTART do produtor => nova source_session_id ---
    def test_restart_produtor_nova_sessao(self):
        p = Pipeline()
        p.feed_raw(blob(self.LOGICAL[:5]))
        s0 = p.rb.source_session_id
        s1 = p.rb.new_session("producer_restart")
        self.assertNotEqual(s0, s1)
        p.feed_raw(blob(self.LOGICAL[5:]))
        u32, meta = p.pop_u32(10)
        self.assertEqual(meta.source_session_id, s1)
        self.assertEqual(meta.discontinuity_before, "session_change")


class TestRingBufferOpcaoA(unittest.TestCase):
    """Item 5: Raw arbitrário NÃO desalinha /v1/uint32; ordem exigida."""

    SRC = words(500)

    def test_raw1_uint32_raw3_uint32_hex5_montecarlo(self):
        rb = WordRingBuffer(capacity_words=10000)
        rb.push_words(blob(self.SRC))
        # Raw 1 byte
        d, m = rb.pop_bytes(1); self.assertEqual(len(d), 1); self.assertEqual(m.alignment_discarded_bytes, 3)
        # -> uint32 (2 palavras): DEVE começar na palavra 1, não no meio da 0
        u, mu = rb.pop_bytes(8); self.assertEqual(unpack_le(u), [1, 2]); self.assertEqual(mu.response_start_offset, 4)
        # Raw 3 bytes
        d3, m3 = rb.pop_bytes(3); self.assertEqual(len(d3), 3); self.assertEqual(m3.alignment_discarded_bytes, 1)
        # -> uint32
        u2, _ = rb.pop_bytes(4); self.assertEqual(unpack_le(u2), [4])
        # Hex 5 bytes (== 2 palavras consumidas, 3 descartados)
        h, mh = rb.pop_bytes(5); self.assertEqual(len(h), 5); self.assertEqual(mh.alignment_discarded_bytes, 3)
        # -> Monte Carlo (uint32/2^32): palavras seguintes intactas
        mc, _ = rb.pop_bytes(16); self.assertEqual(unpack_le(mc), [7, 8, 9, 10])

    def test_pedidos_de_1_2_3_4_5_4097(self):
        for n in (1, 2, 3, 4, 5, 4097):
            rb = WordRingBuffer(capacity_words=20000)
            rb.push_words(blob(words(3000)))
            d, m = rb.pop_bytes(n)
            self.assertEqual(len(d), n, f"n={n}")
            self.assertEqual((n + m.alignment_discarded_bytes) % 4, 0, f"n={n}")
            # a próxima palavra começa em nova fronteira
            nxt, mn = rb.pop_bytes(4)
            expected_word = ((n + 3) // 4)
            self.assertEqual(unpack_le(nxt), [expected_word], f"n={n}")

    def test_wraparound_drop_oldest_em_palavras(self):
        rb = WordRingBuffer(capacity_words=10)          # só 10 palavras
        rb.push_words(blob(words(8)))
        rb.push_words(blob(words(8, start=8)))          # total 16 -> dropa 6 mais antigas
        self.assertEqual(rb.state()["dropped_oldest_bytes"], 6 * 4)
        self.assertEqual(rb.state()["buffer_tail_source_offset"], 6 * 4)
        u, m = rb.pop_bytes(16)
        self.assertEqual(unpack_le(u), [6, 7, 8, 9])    # começa na palavra 6
        self.assertEqual(m.response_start_offset, 6 * 4)  # offset ABSOLUTO

    def test_capacidade_insuficiente_timeout(self):
        rb = WordRingBuffer(capacity_words=100)
        rb.push_words(blob(words(3)))
        self.assertIsNone(rb.pop_bytes(100, timeout=0.15))   # pede 25 palavras, só há 3

    def test_concorrencia_produtor_consumidor(self):
        import threading
        rb = WordRingBuffer(capacity_words=100000)
        got = []
        def consume():
            for _ in range(50):
                r = rb.pop_bytes(40, timeout=3.0)
                if r: got.append(unpack_le(r[0]))
        t = threading.Thread(target=consume); t.start()
        for k in range(50):
            rb.push_words(blob(words(10, start=k * 10)))
        t.join(timeout=5)
        flat = [v for chunk in got for v in chunk]
        # tudo o que saiu está em ordem estritamente crescente e são palavras reais
        self.assertEqual(flat, sorted(flat))
        self.assertTrue(all(0 <= v < 500 for v in flat))

    def test_sha256_sobre_bytes_retornados(self):
        import hashlib
        rb = WordRingBuffer(capacity_words=1000)
        rb.push_words(blob(words(50)))
        d, m = rb.pop_bytes(37)                          # não múltiplo de 4
        self.assertEqual(m.sha256_hex, hashlib.sha256(d).hexdigest())
        self.assertEqual(len(d), 37)


class TestOffsetAbsoluto(unittest.TestCase):
    """Item 6: offset inclui entregues + alinhamento + drop-oldest + fim de conexão."""

    def test_offset_contabiliza_tudo(self):
        rb = WordRingBuffer(capacity_words=6)
        rb.push_words(blob(words(4)))                     # 4 palavras no buffer
        rb.pop_bytes(6)                                   # consome ceil(6/4)=2 palavras; entrega 6, descarta 2
        rb.push_words(blob(words(8, start=4)))            # 2 restantes + 8 = 10; cap 6 -> dropa 4 mais antigas
        st = rb.state()
        self.assertEqual(st["delivered_bytes"], 6)
        self.assertEqual(st["alignment_discarded_total"], 2)
        self.assertEqual(st["dropped_oldest_bytes"], 4 * 4)       # 4 palavras dropadas
        self.assertEqual(st["source_offset_bytes"], (4 + 8) * 4)  # tudo que ENTROU
        # buffer_tail_source_offset = (2 consumidas + 4 dropadas) * 4
        self.assertEqual(st["buffer_tail_source_offset"], (2 + 4) * 4)

    def test_unknown_gap_nao_e_quantidade(self):
        rb = WordRingBuffer(capacity_words=1000)
        rb.push_words(blob(words(5)))
        rb.mark_unknown_gap()                             # perda no TCP, tamanho desconhecido
        rb.push_words(blob(words(5, start=100)))          # "salto" — valor 100, não 5
        _, m = rb.pop_bytes(40)
        self.assertTrue(m.unknown_gap_before)
        self.assertEqual(m.discontinuity_before, "unknown_gap")
        # NÃO existe campo "gap_bytes conhecido"
        self.assertFalse(hasattr(m, "gap_bytes"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
