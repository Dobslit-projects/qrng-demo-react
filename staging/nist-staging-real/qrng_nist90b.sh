#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Uso:"
  echo "  $0 <arquivo_entrada> <iid|non_iid|both> [auto|raw|u32txt|bits]"
  echo ""
  echo "Exemplos:"
  echo "  $0 teste_novo.txt both auto"
  echo "  $0 dados.bin non_iid raw"
  echo "  $0 bits_0101.txt both bits"
  exit 1
fi

IN="$1"
TEST="$2"
FORMAT="${3:-auto}"

if [ ! -f "$IN" ]; then
  echo "Erro: arquivo não encontrado: $IN"
  exit 1
fi

if [ ! -x "./ea_iid" ] || [ ! -x "./ea_non_iid" ]; then
  echo "Erro: rode este script dentro do diretório cpp, onde existem ./ea_iid e ./ea_non_iid"
  exit 1
fi

BASENAME="$(basename "$IN")"
SAFEBASE="${BASENAME%.*}"
OUTDIR="results_${SAFEBASE}_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$OUTDIR"

WORK="$OUTDIR/work"
mkdir -p "$WORK"

echo "Arquivo de entrada: $IN"
echo "Modo de teste: $TEST"
echo "Formato solicitado: $FORMAT"
echo "Saída em: $OUTDIR"
echo ""

detect_format() {
  local file="$1"

  if file "$file" | grep -qi "text"; then
    # Verifica se é só 0/1 e espaços/quebras de linha.
    if python3 - "$file" <<'PY'
from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text(errors="ignore")
chars = set(s.strip())
if chars and chars.issubset(set("01 \n\r\t")):
    sys.exit(0)
sys.exit(1)
PY
    then
      echo "bits"
    else
      echo "u32txt"
    fi
  else
    echo "raw"
  fi
}

if [ "$FORMAT" = "auto" ]; then
  FORMAT="$(detect_format "$IN")"
fi

echo "Formato detectado/usado: $FORMAT"
echo ""

BINFILE=""
BITS_PER_SYMBOL="8"

case "$FORMAT" in
  raw)
    BINFILE="$IN"
    BITS_PER_SYMBOL="8"
    ;;

  u32txt)
    BINFILE="$WORK/${SAFEBASE}_u32_le.bin"
    python3 - "$IN" "$BINFILE" <<'PY'
from pathlib import Path
import struct
import sys

inp = Path(sys.argv[1])
out = Path(sys.argv[2])

vals = []
for i, tok in enumerate(inp.read_text(errors="ignore").split(), 1):
    try:
        v = int(tok)
    except ValueError:
        raise ValueError(f"Token {i} não é inteiro: {tok!r}")

    if not 0 <= v <= 0xffffffff:
        raise ValueError(f"Token {i}: valor fora de uint32: {v}")

    vals.append(v)

if len(vals) == 0:
    raise ValueError("Nenhum inteiro encontrado no arquivo.")

out.write_bytes(b"".join(struct.pack("<I", v) for v in vals))

print(f"Amostras uint32: {len(vals)}")
print(f"Bytes gerados: {len(vals) * 4}")
print(f"Mínimo: {min(vals)}")
print(f"Máximo: {max(vals)}")
print(f"Binário gerado: {out}")
PY
    BITS_PER_SYMBOL="8"
    ;;

  bits)
    BINFILE="$WORK/${SAFEBASE}_bits_symbols.bin"
    python3 - "$IN" "$BINFILE" <<'PY'
from pathlib import Path
import sys

inp = Path(sys.argv[1])
out = Path(sys.argv[2])

s = ''.join(c for c in inp.read_text(errors="ignore") if c in "01")

if len(s) == 0:
    raise ValueError("Nenhum bit 0/1 encontrado no arquivo.")

out.write_bytes(bytes(int(c) for c in s))

print(f"Bits/símbolos gerados: {len(s)}")
print(f"Binário gerado: {out}")
PY
    BITS_PER_SYMBOL="1"
    ;;

  *)
    echo "Erro: formato inválido: $FORMAT"
    echo "Use: auto, raw, u32txt ou bits"
    exit 1
    ;;
esac

echo ""
echo "Arquivo binário para o NIST: $BINFILE"
echo "bits_per_symbol: $BITS_PER_SYMBOL"
echo ""

cp "$IN" "$OUTDIR/original_${BASENAME}" || true
sha256sum "$IN" > "$OUTDIR/sha256_original.txt"
sha256sum "$BINFILE" > "$OUTDIR/sha256_binario_usado.txt"

run_iid() {
  echo "Rodando IID..."
  ./ea_iid -v "$BINFILE" "$BITS_PER_SYMBOL" | tee "$OUTDIR/${SAFEBASE}_iid.txt"
}

run_non_iid() {
  echo "Rodando non-IID..."
  ./ea_non_iid -v "$BINFILE" "$BITS_PER_SYMBOL" | tee "$OUTDIR/${SAFEBASE}_non_iid.txt"
}

case "$TEST" in
  iid)
    run_iid
    ;;
  non_iid)
    run_non_iid
    ;;
  both)
    run_iid
    echo ""
    run_non_iid
    ;;
  *)
    echo "Erro: teste inválido: $TEST"
    echo "Use: iid, non_iid ou both"
    exit 1
    ;;
esac

echo ""
echo "Resumo:"
grep -hE "Passed IID|failed|H_original|H_bitstring|min\\(H_original|Most Common Value Estimate|Compression Test Estimate|LZ78Y Prediction Test Estimate" "$OUTDIR"/*.txt || true

echo ""
echo "Concluído. Resultados em:"
echo "  $OUTDIR"
