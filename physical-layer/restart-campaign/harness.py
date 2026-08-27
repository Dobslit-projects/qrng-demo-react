# -*- coding: utf-8 -*-
"""Harness da restart campaign (fase item 9).

Objetivo: coletar 1.000 reinicializacoes x 1.000 amostras, uma linha POR
REINICIALIZACAO FISICA VALIDA da noise source -- nunca por corte de stream
continuo.

Estado atual: a campanha esta BLOQUEADA (ver RESTART_CAMPAIGN.md) porque o
"restart real da noise source" ainda e INCONCLUSIVO (lado FPGA inacessivel
nesta sessao). Este harness fica PRONTO: define o formato das linhas, o
protocolo por restart, e roda um PILOTO PEQUENO SOMENTE COM FIXTURE
(claramente identificado como simulado). NAO executa mil reinicializacoes.
NAO toca equipamento produtivo.
"""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field, asdict
from typing import Callable, Optional


# ---- Alternativas de restart e o que cada uma reinicia ----------------------
RESTART_KINDS = {
    "process_restart": {
        "acao": "systemctl restart qrng-fifo.service qrng-api.service",
        "reinicia_fonte": False,
        "reinicia_transporte": True,
        "nota": "processos Linux consumindo /tmp/fifo_qrng; o connector reconecta ao :12345 e retoma o MESMO stream fisico. NAO e restart da fonte.",
    },
    "fifo_reset": {
        "acao": "recriar /tmp/fifo_qrng (mkfifo) / reiniciar qrng-fifo.service",
        "reinicia_fonte": False,
        "reinicia_transporte": True,
        "nota": "FIFO e buffer digital; hipotese (nao confirmada): so transporte.",
    },
    "qrng_core_reset": {
        "acao": "reset do bloco QRNG no RTL via registrador AXI (se existir)",
        "reinicia_fonte": None,  # INCONCLUSIVO
        "reinicia_transporte": True,
        "nota": "INCONCLUSIVO -- depende do RTL. Pode reiniciar a maquina de digitizacao sem re-seedar a fonte fisica analogica.",
    },
    "fpga_reset": {
        "acao": "recarregar bitstream / reset PL da Red Pitaya",
        "reinicia_fonte": None,  # provavel, nao confirmado
        "reinicia_transporte": True,
        "nota": "provavel restart da fonte, NAO confirmado (RTL/datasheet nao acessados).",
    },
    "power_cycle": {
        "acao": "power-cycle fisico da placa",
        "reinicia_fonte": True,   # hipotese mais forte
        "reinicia_transporte": True,
        "nota": "hipotese mais forte de 'restart real da noise source'; ainda nao verificada empiricamente.",
    },
}


@dataclass
class RestartRow:
    restart_index: int
    restart_kind: str
    command: str
    started_at: str
    source_state_confirmed: bool
    stabilization_seconds: float
    startup_discarded_samples: int
    collected_samples: int
    line_sha256: str            # hash das `collected_samples` amostras desta linha
    failures: list = field(default_factory=list)
    operational_conditions: dict = field(default_factory=dict)
    hw_version: str = "UNKNOWN"
    sw_version: str = "UNKNOWN"
    simulated: bool = True       # True ate um restart fisico real ser executado

    def as_dict(self):
        return asdict(self)


class RestartCampaignHarness:
    def __init__(self, samples_per_restart: int = 1000, startup_discard: int = 1024):
        self.samples_per_restart = samples_per_restart
        self.startup_discard = startup_discard
        self.rows: list[RestartRow] = []

    def run_restart(self, index: int, restart_kind: str,
                    do_restart: Callable[[], None],
                    confirm_source_state: Callable[[], bool],
                    read_samples: Callable[[int], bytes],
                    hw_version: str = "UNKNOWN", sw_version: str = "UNKNOWN",
                    operational_conditions: Optional[dict] = None,
                    simulated: bool = True) -> RestartRow:
        if restart_kind not in RESTART_KINDS:
            raise ValueError(f"restart_kind desconhecido: {restart_kind}")
        started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        t0 = time.monotonic()
        failures = []
        try:
            do_restart()
        except Exception as e:  # noqa: BLE001
            failures.append(f"do_restart: {e!r}")
        ok_state = False
        try:
            ok_state = bool(confirm_source_state())
        except Exception as e:  # noqa: BLE001
            failures.append(f"confirm_source_state: {e!r}")
        stab = round(time.monotonic() - t0, 6)

        # descarta as amostras de startup (NUNCA entram na linha)
        try:
            _ = read_samples(self.startup_discard)
        except Exception as e:  # noqa: BLE001
            failures.append(f"startup_discard read: {e!r}")

        collected = b""
        try:
            collected = read_samples(self.samples_per_restart)
        except Exception as e:  # noqa: BLE001
            failures.append(f"collect read: {e!r}")

        row = RestartRow(
            restart_index=index,
            restart_kind=restart_kind,
            command=RESTART_KINDS[restart_kind]["acao"],
            started_at=started,
            source_state_confirmed=ok_state,
            stabilization_seconds=stab,
            startup_discarded_samples=self.startup_discard,
            collected_samples=len(collected),
            line_sha256=hashlib.sha256(collected).hexdigest(),
            failures=failures,
            operational_conditions=operational_conditions or {},
            hw_version=hw_version, sw_version=sw_version,
            simulated=simulated,
        )
        self.rows.append(row)
        return row

    def to_jsonl(self) -> str:
        return "\n".join(json.dumps(r.as_dict()) for r in self.rows)

    def summary(self) -> dict:
        return {
            "restarts": len(self.rows),
            "all_simulated": all(r.simulated for r in self.rows),
            "any_failures": any(r.failures for r in self.rows),
            "distinct_line_hashes": len({r.line_sha256 for r in self.rows}),
            "kinds": sorted({r.restart_kind for r in self.rows}),
        }


# --- PILOTO com fixture (SIMULADO, claramente identificado) -----------------
def fixture_pilot(n_restarts: int = 3, seed: int = 20260827) -> RestartCampaignHarness:
    """Roda `n_restarts` (pequeno!) com uma 'fonte' de fixture determinística.
    Cada 'restart' re-seeda o gerador -> linhas distintas. SIMULADO."""
    import random

    h = RestartCampaignHarness(samples_per_restart=1000, startup_discard=1024)
    for i in range(n_restarts):
        rng = random.Random(seed + i)  # 're-seed' = proxy de restart

        def _read(n, _rng=rng):
            return bytes(_rng.getrandbits(8) for _ in range(n))

        h.run_restart(
            index=i,
            restart_kind="power_cycle",
            do_restart=lambda: None,
            confirm_source_state=lambda: True,
            read_samples=_read,
            hw_version="FIXTURE", sw_version="FIXTURE",
            operational_conditions={"note": "PILOTO SIMULADO -- nao e restart fisico"},
            simulated=True,
        )
    return h


if __name__ == "__main__":
    h = fixture_pilot(3)
    print(h.to_jsonl())
    print("\nsummary:", json.dumps(h.summary(), indent=1))
