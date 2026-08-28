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

# Marcadores de controle (primeiros 64 bytes do arquivo) para os testes:
HEAD64=$(head -c 64 "$INPUT")
case "$HEAD64" in
  *FORCE_NIST_FAKE_FAILURE*)
    echo "STAGING FAKE: falha forcada para teste" >&2 ; exit 3 ;;
esac

OUTDIR="results_staging_$(date +%s)_$$"
mkdir -p "$OUTDIR"

echo "STAGING FAKE ASSESSMENT (nao e SP 800-90B real)"
echo "Input: $INPUT  Tipo: $TEST_TYPE  Formato: $FMT"
echo "Rodando IID..."
echo "	Most Common Value Estimate (bit string) = 0.998765 / 1 bit(s)"
echo "	Most Common Value Estimate = 7.912345 / 8 bit(s)"
echo "H_original: 7.912345"
echo "H_bitstring: 0.998765"
echo "min(H_original, 8 X H_bitstring): 7.912345"
echo "Passed chi square tests"
echo "Passed length of longest repeated substring test"
echo "Passed IID permutation tests"
echo "Rodando non-IID..."

case "$HEAD64" in
  *FORCE_NIST_FAKE_PARTIAL*)
    # "parser recebe saida incompleta": trilha bitstring ausente, sem min(...)
    echo "	Most Common Value Estimate = 7.900000 / 8 bit(s)"
    echo "	T-Tuple Test Estimate = 7.802345 / 8 bit(s)"
    echo "H_original: 7.802345"
    echo "Saída em: $OUTDIR"
    exit 0 ;;
  *FORCE_NIST_FAKE_ORIGINAL_LIMITS*)
    # trilha ORIGINAL limita: H_original < 8 x H_bitstring
    echo "	Most Common Value Estimate (bit string) = 0.999000 / 1 bit(s)"
    echo "	Most Common Value Estimate = 7.850000 / 8 bit(s)"
    echo "	Compression Test Estimate (bit string) = 0.998000 / 1 bit(s)"
    echo "	T-Tuple Test Estimate (bit string) = 0.999500 / 1 bit(s)"
    echo "	T-Tuple Test Estimate = 7.600000 / 8 bit(s)"
    echo "H_original: 7.600000"
    echo "H_bitstring: 0.998000"
    echo "min(H_original, 8 X H_bitstring): 7.600000"
    echo "Saída em: $OUTDIR"
    exit 0 ;;
  *FORCE_NIST_FAKE_TIE*)
    # empate: H_original == 8 x H_bitstring
    echo "	Most Common Value Estimate (bit string) = 0.975000 / 1 bit(s)"
    echo "	Compression Test Estimate (bit string) = 0.950000 / 1 bit(s)"
    echo "	Most Common Value Estimate = 7.600000 / 8 bit(s)"
    echo "	T-Tuple Test Estimate = 7.600000 / 8 bit(s)"
    echo "H_original: 7.600000"
    echo "H_bitstring: 0.950000"
    echo "min(H_original, 8 X H_bitstring): 7.600000"
    echo "Saída em: $OUTDIR"
    exit 0 ;;
esac

# Caso padrao: trilha BITSTRING limita (como no arquivo real observado):
#   H_original  = 7.900000        (menor "= X / 8 bit(s)" -> T-Tuple)
#   H_bitstring = 0.975000        (menor "(bit string) = X / 1 bit(s)" -> Compression)
#   min(H_original, 8 x H_bitstring) = min(7.9, 7.8) = 7.800000  -> limiting_path=bitstring
echo "	Most Common Value Estimate (bit string) = 0.997000 / 1 bit(s)"
echo "	Most Common Value Estimate = 7.950000 / 8 bit(s)"
echo "	Collision Test Estimate (bit string) = 0.990000 / 1 bit(s)"
echo "	Markov Test Estimate (bit string) = 0.985000 / 1 bit(s)"
echo "	Compression Test Estimate (bit string) = 0.975000 / 1 bit(s)"
echo "	T-Tuple Test Estimate (bit string) = 0.992000 / 1 bit(s)"
echo "	T-Tuple Test Estimate = 7.900000 / 8 bit(s)"
echo "	LRS Test Estimate (bit string) = 0.995000 / 1 bit(s)"
echo "	LRS Test Estimate = 7.980000 / 8 bit(s)"
echo "H_original: 7.900000"
echo "H_bitstring: 0.975000"
echo "min(H_original, 8 X H_bitstring): 7.800000"
echo "Saída em: $OUTDIR"
exit 0
