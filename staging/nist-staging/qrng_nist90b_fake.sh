#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# STAGING FAKE — NÃO é a suíte NIST SP 800-90B real.
#
# Emite saída canônica DETERMINÍSTICA no mesmo formato que o serviço parseia
# (_parse_output em nist_service.py), para exercitar fila / persistência /
# histórico / lifecycle de job SEM depender da suíte C++ real. Os números
# abaixo são fixos e NÃO representam nenhuma avaliação de entropia.
#
# Nunca use em produção. O serviço marca este ambiente com
# NIST_SERVICE_ENV=staging no /health e todo job carrega sample_origin.
# ─────────────────────────────────────────────────────────────────────────────
INPUT="$1"
TEST_TYPE="${2:-both}"
FMT="${3:-auto}"

if [ ! -f "$INPUT" ]; then
  echo "STAGING FAKE: arquivo de entrada nao encontrado: $INPUT" >&2
  exit 2
fi

# Modo de falha controlado para o teste "worker failure": se o arquivo salvo
# contiver o marcador na primeira linha, sai com erro sem produzir saída.
if head -c 32 "$INPUT" | grep -q "FORCE_NIST_FAKE_FAILURE"; then
  echo "STAGING FAKE: falha forcada para teste" >&2
  exit 3
fi

OUTDIR="results_staging_$(date +%s)_$$"
mkdir -p "$OUTDIR"

echo "STAGING FAKE ASSESSMENT (nao e SP 800-90B real)"
echo "Input: $INPUT  Tipo: $TEST_TYPE  Formato: $FMT"
echo "Rodando IID..."
echo "H_original: 7.912345"
echo "H_bitstring: 0.998765"
echo "min(H_original, 8 X H_bitstring): 7.912345"
echo "Passed chi square tests"
echo "Passed length of longest repeated substring test"
echo "Passed IID permutation tests"
echo "Rodando non-IID..."
echo "H_original: 7.802345"
echo "H_bitstring: 0.997000"
echo "min(H_original, 8 X H_bitstring): 7.802345"
echo "Most Common Value Estimate = 7.850000 / 8 bit(s)"
echo "Collision Estimate = 7.802345 / 8 bit(s)"
echo "Markov Estimate = 7.900000 / 8 bit(s)"
echo "Saída em: $OUTDIR"
exit 0
