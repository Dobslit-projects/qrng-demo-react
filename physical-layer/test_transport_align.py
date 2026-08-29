# -*- coding: utf-8 -*-
"""Testes do realinhamento de palavra + descontinuidade (itens 2, 3, 6).

Desconexões DETERMINÍSTICAS: corta o stream após exatamente N bytes com
N % 4 ∈ {0,1,2,3}, reconecta, e verifica:
  - o WordAligner só entrega palavras completas;
  - reconexão num offset não múltiplo de 4 -> descarta (4 - N%4)%4 bytes;
  - o grid uint32 volta a bater com a origem lógica após o realinhamento;
  - cada evento (reconnect/realign/drop_oldest) vira um Discontinuity;
  - nada de metadata entra no stream.
NADA aqui toca produção.
"""
import json
import struct
import unittest

from transport_align import WordAligner, parse_connector_events, WORD


def words(n, start=0):
    return b"".join(struct.pack("<I", start + i) for i in range(n))


def as_u32(b):
    assert len(b) % 4 == 0
    return list(struct.unpack(f"<{len(b)//4}I", b))


class TestAlignerHappyPath(unittest.TestCase):
    def test_so_entrega_palavras_completas(self):
        a = WordAligner()
        out = a.feed(words(3) + b"\x09\x09")          # 12 + 2 bytes
        self.assertEqual(len(out), 12)
        self.assertEqual(as_u32(out), [0, 1, 2])
        self.assertEqual(a.state()["held_partial_bytes"], 2)
        out2 = a.feed(b"\x00\x00")                    # completa a 4a palavra
        self.assertEqual(as_u32(out2), [0x00000909])
        self.assertTrue(a.state()["word_aligned"])

    def test_stream_offset_monotono(self):
        a = WordAligner()
        a.feed(words(5))
        self.assertEqual(a.out_offset, 20)
        a.feed(words(5, 5))
        self.assertEqual(a.out_offset, 40)
        self.assertEqual(a.state()["stream_offset"], 40)

    def test_sem_descontinuidade_sem_reconexao(self):
        a = WordAligner()
        a.feed(words(100))
        self.assertFalse(a.discontinuous())
        self.assertEqual(a.state()["discontinuities"], 0)


class TestDesconexoesDeterministicas(unittest.TestCase):
    """Fonte lógica = words(50). Corta após N bytes, perde P bytes, reconecta."""

    def _run(self, cut_at, lost):
        logical = words(50)
        a = WordAligner()
        # antes da queda: connector repassou `cut_at` bytes
        pre = a.feed(logical[:cut_at])
        # reconexão: o connector caiu tendo repassado `cut_at` bytes (crus).
        # a fonte continua; `lost` bytes somem na rede.
        a.note_reconnect(connector_forwarded_offset=cut_at)
        post = a.feed(logical[cut_at + lost:])
        return a, pre + post, logical

    def test_perda_multipla_de_4_mantem_alinhamento(self):
        a, out, logical = self._run(cut_at=20, lost=8)   # perde 2 palavras exatas
        self.assertEqual(len(out) % 4, 0)
        # out = words[0..4] + words[7..49]  (palavras 5,6 perdidas, sem desalinhar)
        self.assertEqual(as_u32(out)[:5], [0, 1, 2, 3, 4])
        self.assertEqual(as_u32(out)[5], 7)
        # reconnect registrado, mas SEM realign (offset 20 já é múltiplo de 4)
        kinds = [d.kind for d in a.discontinuities]
        self.assertIn("reconnect", kinds)
        self.assertNotIn("realign", kinds)

    def test_perda_de_2_bytes_realinha_descartando_2(self):
        # o connector recebeu 22 bytes crus quando caiu (`forwarded_offset=22`);
        # a nova conexão retoma do byte 22 (nada além disso se perdeu). 22 % 4 = 2
        # -> o aligner descarta 2 bytes p/ encaixar o grid na palavra 6 (byte 24).
        logical = words(50)
        a = WordAligner()
        a.feed(logical[:22])                              # 5 palavras + 2 segurados
        a.note_reconnect(connector_forwarded_offset=22)   # 22 % 4 = 2 -> descarta 2
        realign = [d for d in a.discontinuities if d.kind == "realign"]
        self.assertEqual(len(realign), 1)
        self.assertEqual(realign[0].bytes_dropped, 2)
        out = a.feed(logical[22:])                        # retoma do byte 22; descarta 22,23
        self.assertEqual(len(out) % 4, 0)
        self.assertEqual(as_u32(out)[0], 6)               # grid re-encaixado na palavra 6
        self.assertEqual(a.state()["realign_bytes_total"], 2)

    def test_perda_de_1_e_de_3_bytes(self):
        for misalign, expect_drop in ((1, 3), (3, 1)):
            logical = words(50)
            a = WordAligner()
            a.feed(logical[: 20 + misalign])
            a.note_reconnect(connector_forwarded_offset=20 + misalign)
            r = [d for d in a.discontinuities if d.kind == "realign"]
            self.assertEqual(r[0].bytes_dropped, expect_drop, f"misalign={misalign}")
            out = a.feed(logical[20 + misalign:])         # retoma; descarta expect_drop
            self.assertEqual(len(out) % 4, 0)
            self.assertEqual(as_u32(out)[0], 6, f"misalign={misalign}")   # palavra 6

    def test_realinhamento_atravessa_multiplos_feeds(self):
        a = WordAligner()
        a.feed(words(3))
        a.note_reconnect(connector_forwarded_offset=13)   # descarta 3
        self.assertEqual(a.state()["pending_realign_bytes"], 3)
        o1 = a.feed(b"\x01")                              # 1 de 3 descartados
        self.assertEqual(o1, b"")
        self.assertEqual(a.state()["pending_realign_bytes"], 2)
        o2 = a.feed(b"\x02\x03" + words(2))               # 2 descartados + 2 palavras
        self.assertEqual(len(o2), 8)
        self.assertEqual(a.state()["pending_realign_bytes"], 0)


class TestDropOldest(unittest.TestCase):
    def test_drop_oldest_vira_descontinuidade(self):
        a = WordAligner()
        a.feed(words(10))
        a.note_drop_oldest(dropped=4096)
        d = a.discontinuities[-1]
        self.assertEqual(d.kind, "drop_oldest")
        self.assertEqual(d.bytes_dropped, 4096)
        self.assertTrue(a.discontinuous())


class TestSemMetadataNoStream(unittest.TestCase):
    def test_saida_e_so_bytes_da_fonte(self):
        logical = words(30)
        a = WordAligner()
        a.feed(logical[:40])
        a.note_reconnect(connector_forwarded_offset=40)
        out = a.feed(logical[40:])
        combined = a.feed(b"")  # nada
        full = logical[:40] + logical[40:]
        # a saída acumulada é um SUBCONJUNTO CONTÍGUO dos bytes da fonte
        # (nenhum byte inventado): cada palavra de `out` existe em `logical`
        for w in as_u32(out):
            self.assertIn(struct.pack("<I", w), logical)


class TestConnectorEventSideband(unittest.TestCase):
    def test_parse_jsonl(self):
        txt = (
            '{"event":"connect","forwarded_offset":0,"ts":"2026-08-29T00:00:00Z"}\n'
            'lixo nao json\n'
            '{"event":"reconnect","forwarded_offset":123457,"ts":"2026-08-29T00:01:00Z","backoff_s":2}\n'
        )
        evs = parse_connector_events(txt)
        self.assertEqual(len(evs), 2)
        self.assertEqual(evs[1]["event"], "reconnect")
        self.assertEqual(evs[1]["forwarded_offset"], 123457)

    def test_evento_reconnect_dispara_realign_no_aligner(self):
        evs = parse_connector_events(
            '{"event":"reconnect","forwarded_offset":999999,"ts":"t","backoff_s":4}\n')
        a = WordAligner()
        a.feed(words(10))
        for e in evs:
            if e["event"] == "reconnect":
                a.note_reconnect(e["forwarded_offset"], e.get("backoff_s", 0))
        # 999999 % 4 == 3 -> descarta 1
        self.assertEqual([d.bytes_dropped for d in a.discontinuities if d.kind == "realign"], [1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
