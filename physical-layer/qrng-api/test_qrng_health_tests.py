# -*- coding: utf-8 -*-
"""Testes deterministicos para RCT/APT e a maquina de estados de saude
(item 7 da rodada de estabilizacao). Cobre exatamente os cenarios pedidos:
sequencia abaixo/no/acima do cutoff (RCT e APT), janela incompleta,
reinicializacao de estado, falha no startup, falha em operacao, recuperacao."""
import unittest
from qrng_health_tests import (
    RCTState, APTState, QrngHealthMonitor, HealthState, HealthTestFailure,
    rct_cutoff, apt_cutoff, LANE_RCT_CUTOFF, LANE_APT_CUTOFF,
)


def word(b0, b1=0, b2=0, b3=0):
    return bytes([b0, b1, b2, b3])


class TestThresholdFormulas(unittest.TestCase):
    def test_rct_cutoff_formula_matches_preliminary_values(self):
        # H=6.978486 -> RCT=4 (valor ja citado no pedido do usuario)
        self.assertEqual(rct_cutoff(6.978486), 4)

    def test_apt_cutoff_formula_matches_preliminary_value_lane0(self):
        self.assertEqual(apt_cutoff(6.978486, window=512), 18)

    def test_thresholds_diferem_por_lane_conforme_min_entropia_medida(self):
        # lane0 tem a MENOR min-entropia (maior p de repeticao natural) -->
        # precisa de um cutoff MAIOR para manter a mesma taxa de falso
        # positivo (alpha) que uma lane com mais entropia -- um cutoff
        # apertado demais numa lane fraca dispararia falhas so pela
        # aleatoriedade natural, nao por um problema real da fonte.
        self.assertGreaterEqual(LANE_APT_CUTOFF[0], LANE_APT_CUTOFF[1])


class TestRCT(unittest.TestCase):
    def test_sequencia_abaixo_do_cutoff_nao_falha(self):
        rct = RCTState(lane=0)  # cutoff=4
        for _ in range(rct.cutoff - 1):  # 3 repeticoes -- abaixo do cutoff
            rct.push(0x42)
        # nao levantou excecao

    def test_sequencia_exatamente_no_cutoff_falha(self):
        rct = RCTState(lane=0)  # cutoff=4
        with self.assertRaises(HealthTestFailure) as ctx:
            for _ in range(rct.cutoff):
                rct.push(0x42)
        self.assertEqual(ctx.exception.test_name, "RCT")
        self.assertEqual(ctx.exception.lane, 0)

    def test_sequencia_acima_do_cutoff_falha_no_primeiro_ponto_de_corte(self):
        rct = RCTState(lane=0)
        count_before_failure = 0
        try:
            for _ in range(rct.cutoff + 5):  # bem acima do cutoff
                rct.push(0x42)
                count_before_failure += 1
        except HealthTestFailure:
            pass
        # a chamada numero `cutoff` (a cutoff-esima ocorrencia consecutiva)
        # e a que levanta -- entao exatamente `cutoff - 1` chamadas
        # anteriores completam sem excecao, nunca mais que isso mesmo
        # pedindo bem mais iteracoes.
        self.assertEqual(count_before_failure, rct.cutoff - 1)

    def test_valores_diferentes_resetam_a_contagem(self):
        rct = RCTState(lane=0)
        rct.push(0x01); rct.push(0x01); rct.push(0x01)  # 3x, abaixo do cutoff=4
        rct.push(0x02)  # valor diferente -- reseta
        rct.push(0x02); rct.push(0x02)  # só 3x no total do novo valor
        # nao deveria ter falhado

    def test_reinicializacao_de_estado_via_reset(self):
        rct = RCTState(lane=0)
        rct.push(0x01); rct.push(0x01); rct.push(0x01)
        rct.reset()
        self.assertIsNone(rct.last_value)
        self.assertEqual(rct.count, 0)
        # depois do reset, precisa de `cutoff` repeticoes de novo para falhar
        for _ in range(rct.cutoff - 1):
            rct.push(0x01)  # nao falha


class TestAPT(unittest.TestCase):
    def test_apt_abaixo_do_limite_nao_falha(self):
        apt = APTState(lane=1, window=512)
        apt.push(0x10)  # define referencia -> B (count) = 1 (SP 800-90B 4.4.2)
        # cutoff-2 matches => B = 1 + (cutoff-2) = cutoff-1, ainda abaixo do cutoff
        for _ in range(apt.cutoff - 2):
            apt.push(0x10)
        self.assertEqual(apt.count, apt.cutoff - 1)
        # nao levantou

    def test_apt_no_limite_falha(self):
        apt = APTState(lane=1, window=512)
        apt.push(0x10)
        with self.assertRaises(HealthTestFailure) as ctx:
            for _ in range(apt.cutoff):
                apt.push(0x10)
        self.assertEqual(ctx.exception.test_name, "APT")

    def test_apt_acima_do_limite_falha_no_primeiro_ponto_de_corte(self):
        apt = APTState(lane=1, window=512)
        apt.push(0x10)  # define a referencia -> B (count) = 1 (SP 800-90B 4.4.2)
        count = 0
        try:
            for _ in range(apt.cutoff + 10):
                apt.push(0x10)
                count += 1
        except HealthTestFailure:
            pass
        # B parte de 1 (a referencia conta). Apos k matches, B = 1 + k. O
        # primeiro k com B >= cutoff e k = cutoff - 1, e a push desse k-esimo
        # match levanta -- entao exatamente cutoff - 2 iteracoes completam antes.
        self.assertEqual(count, apt.cutoff - 2)

    def test_janela_incompleta_no_fim_do_stream_nao_falha_artificialmente(self):
        # Uma janela que nunca chega a se completar (poucos valores) nao deve
        # levantar falha so por causa do fim do stream -- so falha se o
        # cutoff for de fato atingido dentro da janela parcial.
        apt = APTState(lane=1, window=512)
        apt.push(0x10)
        for _ in range(5):  # bem menos que a janela inteira, bem menos que o cutoff
            apt.push(0x10)
        # nao deveria ter falhado -- janela incompleta, cutoff nao atingido

    def test_janela_completa_reinicia_a_referencia(self):
        apt = APTState(lane=1, window=8)
        apt.push(0x10)  # referencia
        # preenche a janela inteira com um valor DIFERENTE da referencia,
        # ficando abaixo do cutoff (nunca bate a referencia de novo)
        for _ in range(7):
            apt.push(0x99)
        # janela completou (seen_in_window == window-1) -- referencia reinicia
        self.assertIsNone(apt.reference_value)

    def test_reinicializacao_de_estado_via_reset(self):
        apt = APTState(lane=1, window=512)
        apt.push(0x10); apt.push(0x10); apt.push(0x10)
        apt.reset()
        self.assertIsNone(apt.reference_value)
        self.assertEqual(apt.count, 0)
        self.assertEqual(apt.seen_in_window, 0)


class TestHealthStateMachine(unittest.TestCase):
    def _make_monitor(self, startup=4):
        m = QrngHealthMonitor(lanes=(0,), startup_min_samples=startup)
        m.start()
        return m

    def test_estado_inicial_e_initializing_antes_de_start(self):
        m = QrngHealthMonitor(lanes=(0,))
        self.assertEqual(m.state, HealthState.INITIALIZING)
        with self.assertRaises(RuntimeError):
            m.push_word(word(0x01))  # nao pode alimentar antes de start()

    def test_startup_descarta_amostras_e_nao_retorna_nada(self):
        m = self._make_monitor(startup=4)
        self.assertEqual(m.state, HealthState.STARTUP_TESTING)
        for i in range(4):
            result = m.push_word(word(i, i, i, i))
            self.assertIsNone(result, "amostra de startup nunca deve ser retornada")
        self.assertEqual(m.state, HealthState.HEALTHY)
        self.assertEqual(m.metrics.qrng_discarded_samples_total, 4)

    def test_nenhuma_saida_antes_da_aprovacao_do_startup_test(self):
        m = self._make_monitor(startup=100)
        for i in range(50):
            result = m.push_word(word(i % 256, 0, 0, 0))
            self.assertIsNone(result)
        self.assertEqual(m.state, HealthState.STARTUP_TESTING, "nao deveria ter aprovado ainda")

    def test_falha_durante_startup_reinicia_o_startup_do_zero_sem_ir_para_failed(self):
        m = self._make_monitor(startup=1000)
        cutoff = LANE_RCT_CUTOFF[0]
        with self.assertRaises(HealthTestFailure):
            for _ in range(cutoff):
                m.push_word(word(0x42, 0, 0, 0))  # repete o mesmo valor -> RCT falha
        # falha durante STARTUP_TESTING nao deve levar a FAILED -- reinicia o startup
        self.assertEqual(m.state, HealthState.STARTUP_TESTING)
        self.assertEqual(m.metrics.qrng_startup_test_failures_total, 1)
        self.assertEqual(m._startup_count, 0, "contagem de startup deve reiniciar do zero")

    def test_falha_durante_operacao_normal_interrompe_a_entrega_live(self):
        m = self._make_monitor(startup=2)
        m.push_word(word(0x01, 0, 0, 0))
        m.push_word(word(0x02, 0, 0, 0))
        self.assertEqual(m.state, HealthState.HEALTHY)
        cutoff = LANE_RCT_CUTOFF[0]
        with self.assertRaises(HealthTestFailure):
            for _ in range(cutoff):
                m.push_word(word(0x99, 0, 0, 0))
        self.assertEqual(m.state, HealthState.FAILED)
        self.assertEqual(m.metrics.qrng_rct_failures_total, 1)

    def test_dados_posteriores_a_falha_nao_entram_no_buffer(self):
        m = self._make_monitor(startup=2)
        m.push_word(word(0x01)); m.push_word(word(0x02))
        cutoff = LANE_RCT_CUTOFF[0]
        with self.assertRaises(HealthTestFailure):
            for _ in range(cutoff):
                m.push_word(word(0x99))
        # qualquer push_word posterior, mesmo com dado "bom", deve ser rejeitado --
        # o estado FAILED bloqueia a entrada, nao so a saida.
        with self.assertRaises(RuntimeError):
            m.push_word(word(0x01, 0x02, 0x03, 0x04))

    def test_recuperacao_exige_procedimento_explicito_nao_automatico(self):
        m = self._make_monitor(startup=2)
        m.push_word(word(0x01)); m.push_word(word(0x02))
        cutoff = LANE_RCT_CUTOFF[0]
        with self.assertRaises(HealthTestFailure):
            for _ in range(cutoff):
                m.push_word(word(0x99))
        self.assertEqual(m.state, HealthState.FAILED)
        # nao existe nenhum caminho automatico de FAILED para HEALTHY --
        # so begin_recovery() -> complete_recovery(), ambos chamados manualmente
        with self.assertRaises(RuntimeError):
            m.recover_to_healthy_from_degraded()  # so valido a partir de DEGRADED
        m.begin_recovery()
        self.assertEqual(m.state, HealthState.RECOVERING)
        m.complete_recovery()
        # recuperacao completa volta para STARTUP_TESTING, nao direto para HEALTHY --
        # a fonte precisa provar saude de novo
        self.assertEqual(m.state, HealthState.STARTUP_TESTING)

    def test_health_payload_estruturado_reflete_falha(self):
        m = self._make_monitor(startup=2)
        m.push_word(word(0x01)); m.push_word(word(0x02))
        cutoff = LANE_RCT_CUTOFF[0]
        with self.assertRaises(HealthTestFailure):
            for _ in range(cutoff):
                m.push_word(word(0x99))
        payload = m.health_payload()
        self.assertEqual(payload["state"], "FAILED")
        self.assertGreaterEqual(payload["metrics"]["qrng_rct_failures_total"], 1)
        self.assertIsNotNone(payload["metrics"]["qrng_last_health_failure_timestamp"])

    def test_degraded_e_um_estado_distinto_de_failed(self):
        m = self._make_monitor(startup=2)
        m.push_word(word(0x01)); m.push_word(word(0x02))
        m.degrade("upstream lento")
        self.assertEqual(m.state, HealthState.DEGRADED)
        m.recover_to_healthy_from_degraded()
        self.assertEqual(m.state, HealthState.HEALTHY)


if __name__ == "__main__":
    unittest.main(verbosity=2)
