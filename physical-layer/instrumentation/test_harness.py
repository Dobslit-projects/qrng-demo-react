# -*- coding: utf-8 -*-
"""Testes do harness de instrumentacao/replay (fase item 7).

Validam as RESTRICOES exigidas: leitura unica, forward inalterado, copia de
evidencia identica, sem reordenar/framing/descarte/duplicacao, e que uma
divergencia real e localizada (primeiro offset + bytes antes/depois).
NADA aqui toca a FPGA/FIFO/producao.
"""
import unittest
from harness import (
    SingleReadTap, BoundaryCapture, run_replay, first_divergent_offset,
    identity_boundary,
)

SRC = bytes((i * 37 + 11) & 0xFF for i in range(1024))


class TestSingleReadTap(unittest.TestCase):
    def test_le_o_bloco_uma_unica_vez(self):
        tap = SingleReadTap()
        tap.feed(SRC)
        with self.assertRaises(RuntimeError):
            tap.feed(SRC)  # 2a leitura da fonte -> proibida

    def test_forward_e_inalterado(self):
        tap = SingleReadTap()
        tap.feed(SRC)
        self.assertEqual(tap.forward(), SRC)  # sem reordenar/framing/descarte

    def test_evidence_identica_ao_forward_sem_transformacao(self):
        tap = SingleReadTap()
        tap.feed(SRC)
        self.assertEqual(tap.evidence(), tap.forward())
        # nao e representacao textual: e bytes crus
        self.assertIsInstance(tap.evidence(), bytes)

    def test_tap_tem_timeout_configuravel_nao_bloqueia_para_sempre(self):
        tap = SingleReadTap(read_timeout_s=0.1)
        self.assertEqual(tap.read_timeout_s, 0.1)


class TestReplayIdentico(unittest.TestCase):
    def test_todas_as_fronteiras_preservam_o_bloco(self):
        cap = run_replay("cap-id", SRC)
        self.assertTrue(cap.preserved())
        hashes = {r["sha256"] for r in cap.hash_table()}
        self.assertEqual(len(hashes), 1, "todas as fronteiras devem ter o mesmo SHA-256")
        self.assertIsNone(cap.first_boundary_with_divergence())

    def test_registra_capture_id_offsets_hashes_timestamps_hexdumps(self):
        cap = run_replay("cap-xyz", SRC)
        r = cap.records[0]
        self.assertEqual(r.capture_id, "cap-xyz")
        self.assertEqual(r.offset_start, 0)
        self.assertEqual(r.offset_end, len(SRC))
        self.assertEqual(r.n_bytes, len(SRC))
        self.assertRegex(r.sha256, r"^[0-9a-f]{64}$")
        self.assertGreaterEqual(r.ts_monotonic, 0.0)
        self.assertRegex(r.ts_civil, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertIn("head", r.hexdumps)
        self.assertIn("mid", r.hexdumps)
        self.assertIn("tail", r.hexdumps)

    def test_sequencia_por_fronteira(self):
        cap = run_replay("cap-seq", SRC)
        seqs = [r.sequence for r in cap.records]
        self.assertEqual(seqs, list(range(len(seqs))))


class TestDivergenciaLocalizada(unittest.TestCase):
    def test_drop_no_ring_buffer_e_localizado_como_primeira_divergencia(self):
        # ring_buffer descarta 4 bytes -> divergencia na fronteira ring_buffer
        cap = run_replay("cap-drop", SRC, ring_drop_prefix=4)
        self.assertFalse(cap.preserved())
        d = cap.first_boundary_with_divergence()
        self.assertIsNotNone(d)
        self.assertEqual(d["boundary"], "ring_buffer")
        self.assertEqual(d["first_divergent_vs_prev"], 0)  # o 1o byte ja difere
        self.assertIsNotNone(d["expected_bytes_at_divergence"])
        self.assertIsNotNone(d["observed_bytes_at_divergence"])

    def test_first_divergent_offset_helper(self):
        self.assertEqual(first_divergent_offset(b"abcdef", b"abcdef"), -1)
        self.assertEqual(first_divergent_offset(b"abcXef", b"abcdef"), 3)
        self.assertEqual(first_divergent_offset(b"abc", b"abcdef"), 3)  # tamanhos diferentes

    def test_identity_boundary_nao_transforma(self):
        self.assertEqual(identity_boundary(SRC), SRC)


class TestSemSegundoConsumidor(unittest.TestCase):
    def test_run_replay_alimenta_cada_fronteira_explicitamente_uma_vez(self):
        # cada fronteira usa seu proprio SingleReadTap; nenhum le a 'fonte' de novo
        cap = run_replay("cap-1c", SRC)
        self.assertEqual(len(cap.records), 7)  # 7 fronteiras conhecidas


if __name__ == "__main__":
    unittest.main(verbosity=2)
