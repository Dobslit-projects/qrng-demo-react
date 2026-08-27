# -*- coding: utf-8 -*-
"""
Item 7 da rodada de estabilizacao: Repetition Count Test (RCT) e Adaptive
Proportion Test (APT), SP 800-90B secao 4.4, implementados sobre a unidade
de amostra formalizada em NOISE_SOURCE_DEFINITION.md: BYTE (8 bits), POR
BYTE-LANE (uma instancia de RCTState/APTState por lane -- nunca sobre um
stream de 32 bits intercalado, porque as 4 lanes tem min-entropias
mensuravelmente diferentes entre si: aplicar um unico threshold ao stream
combinado esconderia a lane mais fraca atras da media das outras 3).

Este modulo e novo codigo, testado em isolamento (ver test_qrng_health_tests.py),
e NAO esta ligado a nenhum caminho de producao. Integra-lo a server_api.py
real (nao versionado, roda ao vivo) e uma mudanca separada que requer
autorizacao explicita -- ver o pedido: "pare antes de... implantar health
tests no caminho live".

Formulas (SP 800-90B 4.4, alpha = 2^-20 -- valor com que as Tabelas 1 e 2 do
documento foram calculadas):
  RCT:  C = 1 + ceil(-log2(alpha) / H)                    (secao 4.4.1)
  APT:  C = 1 + CRITBINOM(W, 2^-H, 1 - alpha)             (secao 4.4.2)
        CRITBINOM(W, p, q) = menor k com P(Binomial(W, p) <= k) >= q.
        Contador do teste = B (comeca em 1, a referencia conta); a janela
        FALHA quando B >= C.  Ver apt_cutoff() e APTState para as variaveis.

Verificacao independente (test_qrng_health_tests.py) contra a Tabela 2 da
SP 800-90B (W=512): H=8 -> C=13, H=4 -> 62, H=2 -> 177, H=1 -> 311, H=0.5 -> 410
(valores literais do documento, mais uma 2a implementacao de referencia
independente via math.comb).

Thresholds por lane, da min-entropia SP 800-90B nao-IID (conservadora) medida
por lane na captura de referencia (docs/nist_lane0_noniid_20260826_output.txt,
docs/nist_lanes123_noniid_20260826_output.txt), alpha=2^-20:

    lane0: H=6.978486  RCT=4   APT(W=512)=18
    lane1: H=7.312323  RCT=4   APT(W=512)=16
    lane2: H=7.331528  RCT=4   APT(W=512)=16
    lane3: H=7.182924  RCT=4   APT(W=512)=16

Estes valores sao PRELIMINARES: (a) calculados sobre UMA captura de
referencia, nao a estimativa pos restart campaign (item 8, bloqueada); (b)
com alpha=2^-20, a taxa AGREGADA de falso bloqueio na vazao real do pipeline
(~170 mil simbolos/s por lane, medida em 2026-08-27) e da ordem de 1 a cada
poucos segundos (ver RCT_APT_REVIEW.md secao "Falso alarme"). Antes de
qualquer integracao live, alpha e os cutoffs precisam ser reorcados para um
objetivo operacional (1 falso bloqueio por dia/mes/ano -> alpha ~2^-33 a
2^-43; ver a tabela no RCT_APT_REVIEW.md). Nada disso e aplicado aqui.
"""
import math
import time
from enum import Enum


def rct_cutoff(min_entropy_bits_per_symbol: float, alpha: float = 2 ** -20) -> int:
    """SP 800-90B 4.4.1: C = 1 + ceil(-log2(alpha) / H)."""
    if min_entropy_bits_per_symbol <= 0:
        raise ValueError("min_entropy_bits_per_symbol deve ser > 0")
    return 1 + math.ceil(-math.log2(alpha) / min_entropy_bits_per_symbol)


def _binom_cdf(n: int, k: int, p: float) -> float:
    """P(X <= k) para X ~ Binomial(n, p). Soma direta da PMF via lgamma.
    Estavel para os n (<=512) e p (>= 2^-8) deste modulo."""
    if k < 0:
        return 0.0
    if k >= n:
        return 1.0
    total = 0.0
    for i in range(0, k + 1):
        logpmf = (math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1)
                  + i * math.log(p) + (n - i) * math.log1p(-p))
        total += math.exp(logpmf)
    return min(total, 1.0)


def _critbinom(n: int, p: float, q: float) -> int:
    """Equivalente a CRITBINOM/BINOM.INV do Excel:
    menor inteiro k em [0, n] tal que P(Binomial(n, p) <= k) >= q.
    Busca binaria sobre a CDF (monotona em k)."""
    lo, hi = 0, n
    while lo < hi:
        mid = (lo + hi) // 2
        if _binom_cdf(n, mid, p) >= q:
            hi = mid
        else:
            lo = mid + 1
    return lo


def apt_cutoff(min_entropy_bits_per_symbol: float, window: int = 512, alpha: float = 2 ** -20) -> int:
    """Cutoff C do Adaptive Proportion Test, formula publicada na NIST SP 800-90B 4.4.2:

        C = 1 + CRITBINOM(W, 2^(-H), 1 - alpha)

    Variaveis (exatamente como na SP 800-90B):
      W     = window  -- numero de amostras por janela do APT (512 para dados
              nao-binarios; a 1a amostra da janela e a referencia A).
      H     = min_entropy_bits_per_symbol  -- min-entropia por simbolo (bits).
      p     = 2^(-H)  -- probabilidade (limite superior) da amostra de
              referencia se repetir, sob a hipotese de min-entropia da SP.
      alpha = probabilidade alvo de falso positivo por janela (SP 800-90B: 2^-20;
              as tabelas 1 e 2 do documento foram calculadas com esse valor).
      CRITBINOM(W, p, 1-alpha) = menor k tal que P(Binomial(W, p) <= k) >= 1-alpha.

    O contador do teste e B (comeca em 1 -- a referencia conta, ver APTState);
    a janela FALHA quando B >= C. Como B = 1 + (matches entre as W-1 amostras
    seguintes), B >= C <=> matches >= C-1. A tabela de C abaixo (test_...py)
    reproduz os valores publicados na Tabela 2 da SP 800-90B para W=512:
    H=8->13, H=4->62, H=2->177, H=1->311, H=0.5->410.
    """
    if min_entropy_bits_per_symbol <= 0:
        raise ValueError("min_entropy_bits_per_symbol deve ser > 0")
    p = 2.0 ** (-min_entropy_bits_per_symbol)
    return 1 + _critbinom(window, p, 1.0 - alpha)


# Thresholds preliminares por lane (ver docstring do modulo).
LANE_MIN_ENTROPY = {0: 6.978486, 1: 7.312323, 2: 7.331528, 3: 7.182924}
LANE_RCT_CUTOFF = {lane: rct_cutoff(h) for lane, h in LANE_MIN_ENTROPY.items()}
LANE_APT_CUTOFF = {lane: apt_cutoff(h) for lane, h in LANE_MIN_ENTROPY.items()}
APT_WINDOW = 512
STARTUP_TEST_MIN_SAMPLES = 1024  # minimo recomendado pela SP 800-90B para startup tests


class HealthState(Enum):
    INITIALIZING = "INITIALIZING"
    STARTUP_TESTING = "STARTUP_TESTING"
    HEALTHY = "HEALTHY"
    DEGRADED = "DEGRADED"
    FAILED = "FAILED"
    RECOVERING = "RECOVERING"


class HealthTestFailure(Exception):
    def __init__(self, test_name: str, lane: int, detail: str):
        self.test_name = test_name
        self.lane = lane
        self.detail = detail
        super().__init__(f"{test_name} failed on lane{lane}: {detail}")


class RCTState:
    """Repetition Count Test -- uma instancia por lane."""
    def __init__(self, lane: int):
        self.lane = lane
        self.cutoff = LANE_RCT_CUTOFF[lane]
        self.last_value = None
        self.count = 0

    def reset(self):
        self.last_value = None
        self.count = 0

    def push(self, value: int):
        """Retorna None se ok, ou levanta HealthTestFailure."""
        if self.last_value == value:
            self.count += 1
            if self.count >= self.cutoff:
                raise HealthTestFailure(
                    "RCT", self.lane,
                    f"valor {value} repetido {self.count} vezes consecutivas (cutoff={self.cutoff})"
                )
        else:
            self.last_value = value
            self.count = 1


class APTState:
    """Adaptive Proportion Test -- uma instancia por lane."""
    def __init__(self, lane: int, window: int = APT_WINDOW):
        self.lane = lane
        self.window = window
        self.cutoff = LANE_APT_CUTOFF[lane]
        self.reference_value = None
        self.count = 0
        self.seen_in_window = 0

    def reset(self):
        self.reference_value = None
        self.count = 0
        self.seen_in_window = 0

    def push(self, value: int):
        if self.reference_value is None:
            self.reference_value = value
            # SP 800-90B 4.4.2: B = 1 -- a amostra de referencia JA conta como
            # uma ocorrencia. Comecar em 0 aqui tornava o APT ~1 ocorrencia
            # menos sensivel que a spec (dispararia so com cutoff matches
            # depois da referencia, quando a spec dispara com cutoff-1).
            self.count = 1
            self.seen_in_window = 0
            return
        self.seen_in_window += 1
        if value == self.reference_value:
            self.count += 1
            if self.count >= self.cutoff:
                raise HealthTestFailure(
                    "APT", self.lane,
                    f"valor de referencia {value} ocorreu {self.count} vezes em "
                    f"{self.seen_in_window+1} amostras (janela={self.window}, cutoff={self.cutoff})"
                )
        if self.seen_in_window >= self.window - 1:
            # janela completa (ou incompleta no fim do stream -- ver testes):
            # reinicia com um novo valor de referencia.
            self.reference_value = None
            self.count = 0
            self.seen_in_window = 0


class HealthTestMetrics:
    """Contadores no formato Prometheus (item 7): incrementados in-process,
    nao persistidos -- ver qrng_health_state.py para exposicao real via /metrics
    quando este modulo for integrado a um servico real."""
    def __init__(self):
        self.qrng_rct_failures_total = 0
        self.qrng_apt_failures_total = 0
        self.qrng_startup_test_failures_total = 0
        self.qrng_health_state = HealthState.INITIALIZING.value
        self.qrng_last_health_failure_timestamp = None
        self.qrng_discarded_samples_total = 0

    def as_dict(self):
        return {
            "qrng_rct_failures_total": self.qrng_rct_failures_total,
            "qrng_apt_failures_total": self.qrng_apt_failures_total,
            "qrng_startup_test_failures_total": self.qrng_startup_test_failures_total,
            "qrng_health_state": self.qrng_health_state,
            "qrng_last_health_failure_timestamp": self.qrng_last_health_failure_timestamp,
            "qrng_discarded_samples_total": self.qrng_discarded_samples_total,
        }


class QrngHealthMonitor:
    """
    Maquina de estados de saude (item 7):

        INITIALIZING -> STARTUP_TESTING -> HEALTHY <-> DEGRADED -> FAILED -> RECOVERING -> STARTUP_TESTING

    Requisitos implementados (ver docstring do pedido):
      - dados do startup test sao descartados (nunca retornados por get_sample)
      - nenhuma saida antes do startup test passar
      - falha de RCT/APT interrompe a entrega live (get_sample levanta)
      - amostras pos-falha nao entram no buffer (push() nao aceita em FAILED)
      - recuperacao exige acao explicita (recover(), nunca automatica)
      - fallback nao e acionado por este modulo -- e responsabilidade do
        chamador tratar a excecao e decidir (nunca silenciosamente)
    """
    def __init__(self, lanes=(0, 1, 2, 3), startup_min_samples: int = STARTUP_TEST_MIN_SAMPLES):
        self.lanes = list(lanes)
        self.startup_min_samples = startup_min_samples
        self.metrics = HealthTestMetrics()
        self._reset_internal(HealthState.INITIALIZING)

    def _reset_internal(self, state: HealthState):
        self.state = state
        self.metrics.qrng_health_state = state.value
        self._rct = {lane: RCTState(lane) for lane in self.lanes}
        self._apt = {lane: APTState(lane) for lane in self.lanes}
        self._startup_count = 0
        self._startup_buffer = []

    def start(self):
        if self.state != HealthState.INITIALIZING:
            raise RuntimeError(f"start() só é válido a partir de INITIALIZING, estado atual={self.state}")
        self.state = HealthState.STARTUP_TESTING
        self.metrics.qrng_health_state = self.state.value

    def _lane_bytes(self, word_bytes: bytes):
        """word_bytes: 4 bytes de uma palavra uint32-LE (o transport word).
        Retorna {lane: byte_value}."""
        return {lane: word_bytes[lane] for lane in self.lanes}

    def push_word(self, word_bytes: bytes):
        """
        Alimenta uma palavra de 4 bytes (transport word). Levanta
        HealthTestFailure e transiciona para FAILED se RCT ou APT falhar em
        qualquer lane. Durante STARTUP_TESTING, acumula amostras descartadas
        até startup_min_samples; se nenhuma falha ocorrer, transiciona para
        HEALTHY. Amostras de startup NUNCA são recuperáveis via get_sample().
        """
        if self.state == HealthState.FAILED:
            raise RuntimeError("push_word() chamado em estado FAILED -- amostras pós-falha não podem entrar no buffer")
        if self.state == HealthState.INITIALIZING:
            raise RuntimeError("push_word() chamado antes de start() -- máquina não inicializada")

        if len(word_bytes) != 4:
            raise ValueError("word_bytes deve ter exatamente 4 bytes (transport word uint32-LE)")

        lane_values = self._lane_bytes(word_bytes)

        try:
            for lane, value in lane_values.items():
                self._rct[lane].push(value)
                self._apt[lane].push(value)
        except HealthTestFailure as failure:
            self.metrics.qrng_last_health_failure_timestamp = time.time()
            if failure.test_name == "RCT":
                self.metrics.qrng_rct_failures_total += 1
            else:
                self.metrics.qrng_apt_failures_total += 1
            if self.state == HealthState.STARTUP_TESTING:
                self.metrics.qrng_startup_test_failures_total += 1
                # Falha durante startup: reinicia o startup test do zero
                # (não é uma falha "em operação" -- a fonte nunca chegou a
                # ser considerada saudável).
                self._startup_count = 0
                self._startup_buffer = []
                for lane_rct in self._rct.values():
                    lane_rct.reset()
                for lane_apt in self._apt.values():
                    lane_apt.reset()
                raise
            self.state = HealthState.FAILED
            self.metrics.qrng_health_state = self.state.value
            raise

        if self.state == HealthState.STARTUP_TESTING:
            self._startup_count += 1
            self.metrics.qrng_discarded_samples_total += 1
            if self._startup_count >= self.startup_min_samples:
                self.state = HealthState.HEALTHY
                self.metrics.qrng_health_state = self.state.value
            return None  # descartado -- nunca retornado ao chamador

        return word_bytes  # HEALTHY (ou DEGRADED -- não implementado como estado distinto de falha parcial nesta versão)

    def degrade(self, reason: str):
        """Transição explícita para DEGRADED (ex.: sinalizada por uma
        camada externa -- upstream lento, buffer baixo -- não por RCT/APT,
        que vão direto para FAILED)."""
        if self.state != HealthState.HEALTHY:
            raise RuntimeError(f"degrade() só é válido a partir de HEALTHY, estado atual={self.state}")
        self.state = HealthState.DEGRADED
        self.metrics.qrng_health_state = self.state.value

    def recover_to_healthy_from_degraded(self):
        if self.state != HealthState.DEGRADED:
            raise RuntimeError(f"recover_to_healthy_from_degraded() só é válido a partir de DEGRADED, estado atual={self.state}")
        self.state = HealthState.HEALTHY
        self.metrics.qrng_health_state = self.state.value

    def begin_recovery(self):
        """Início de um procedimento de recuperação EXPLÍCITO após FAILED --
        nunca automático. O chamador deve ter um motivo documentado (ex.:
        restart controlado confirmado, fonte re-caracterizada)."""
        if self.state != HealthState.FAILED:
            raise RuntimeError(f"begin_recovery() só é válido a partir de FAILED, estado atual={self.state}")
        self.state = HealthState.RECOVERING
        self.metrics.qrng_health_state = self.state.value

    def complete_recovery(self):
        """Recuperação completa: volta para STARTUP_TESTING (não direto para
        HEALTHY) -- a fonte precisa provar saúde de novo, do zero."""
        if self.state != HealthState.RECOVERING:
            raise RuntimeError(f"complete_recovery() só é válido a partir de RECOVERING, estado atual={self.state}")
        self._reset_internal(HealthState.STARTUP_TESTING)

    def health_payload(self):
        """Formato pensado para consumo por um endpoint /health real --
        estruturado, nunca um booleano genérico 'ok'."""
        return {
            "state": self.state.value,
            "lanes": self.lanes,
            "metrics": self.metrics.as_dict(),
        }
