# -*- coding: utf-8 -*-
"""Testes do harness da restart campaign (fase item 9). Só fixture/simulado."""
import json
import unittest
from harness import RestartCampaignHarness, RESTART_KINDS, fixture_pilot


class TestRestartKinds(unittest.TestCase):
    def test_taxonomia_marca_o_que_reinicia_a_fonte(self):
        self.assertFalse(RESTART_KINDS["process_restart"]["reinicia_fonte"])
        self.assertFalse(RESTART_KINDS["fifo_reset"]["reinicia_fonte"])
        self.assertIsNone(RESTART_KINDS["qrng_core_reset"]["reinicia_fonte"])  # INCONCLUSIVO
        self.assertIsNone(RESTART_KINDS["fpga_reset"]["reinicia_fonte"])
        self.assertTrue(RESTART_KINDS["power_cycle"]["reinicia_fonte"])
        for k in RESTART_KINDS.values():
            self.assertTrue(k["reinicia_transporte"])  # todos reiniciam transporte


class TestHarnessRegistraTodosOsCampos(unittest.TestCase):
    def test_linha_tem_os_campos_exigidos(self):
        h = fixture_pilot(2)
        row = h.rows[0].as_dict()
        for campo in ["restart_index", "restart_kind", "command", "started_at",
                      "source_state_confirmed", "stabilization_seconds",
                      "startup_discarded_samples", "collected_samples",
                      "line_sha256", "failures", "operational_conditions",
                      "hw_version", "sw_version", "simulated"]:
            self.assertIn(campo, row)
        self.assertEqual(row["startup_discarded_samples"], 1024)
        self.assertEqual(row["collected_samples"], 1000)
        self.assertRegex(row["line_sha256"], r"^[0-9a-f]{64}$")

    def test_startup_e_descartado_e_nao_entra_na_linha(self):
        # o hash da linha cobre só as 1000 amostras coletadas, não as 1024 de startup
        h = fixture_pilot(1)
        import random, hashlib
        rng = random.Random(20260827 + 0)
        _ = bytes(rng.getrandbits(8) for _ in range(1024))          # startup (descartado)
        expected = bytes(rng.getrandbits(8) for _ in range(1000))   # coletadas
        self.assertEqual(h.rows[0].line_sha256, hashlib.sha256(expected).hexdigest())

    def test_cada_restart_gera_linha_distinta(self):
        h = fixture_pilot(5)
        self.assertEqual(len(h.rows), 5)
        self.assertEqual(len({r.line_sha256 for r in h.rows}), 5)  # re-seed -> linhas distintas

    def test_tudo_marcado_como_simulado(self):
        h = fixture_pilot(3)
        self.assertTrue(h.summary()["all_simulated"])
        self.assertTrue(all(r.simulated for r in h.rows))

    def test_jsonl_serializa(self):
        h = fixture_pilot(2)
        lines = h.to_jsonl().splitlines()
        self.assertEqual(len(lines), 2)
        json.loads(lines[0])


class TestFalhasSaoRegistradas(unittest.TestCase):
    def test_excecao_no_restart_vira_failure_nao_crash(self):
        h = RestartCampaignHarness(samples_per_restart=10, startup_discard=4)
        def boom():
            raise RuntimeError("restart falhou")
        row = h.run_restart(0, "power_cycle", do_restart=boom,
                            confirm_source_state=lambda: False,
                            read_samples=lambda n: b"\x00" * n)
        self.assertTrue(any("restart falhou" in f for f in row.failures))
        self.assertFalse(row.source_state_confirmed)

    def test_piloto_pequeno_nunca_executa_mil(self):
        h = fixture_pilot(3)
        self.assertLessEqual(len(h.rows), 10)


if __name__ == "__main__":
    unittest.main(verbosity=2)
