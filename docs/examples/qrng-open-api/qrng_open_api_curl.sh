#!/usr/bin/env bash
# Exemplos curl da interface QRNG Open API do Kuapoã.
# Variáveis de ambiente:
#   QRNG_OPENAPI_URL  base das rotas (padrão: https://bongo.dobslit.com/qrng/v1)
#   QRNG_API_TOKEN    token de API pessoal (obrigatório; nunca o coloque no script)
# Requer curl e python3 (só para ler o JSON e decodificar o Base64).
set -euo pipefail
BASE="${QRNG_OPENAPI_URL:-https://bongo.dobslit.com/qrng/v1}"
: "${QRNG_API_TOKEN:?defina QRNG_API_TOKEN com o seu token de API}"
AUTH="Authorization: Bearer ${QRNG_API_TOKEN}"

echo "== 1. capacidades"
curl -sS -H "$AUTH" "$BASE/capabilities" | python3 -c '
import json, sys
e = json.load(sys.stdin)["entropy"]
lim = next(x["data"] for x in e["extensions"] if x["name"] == "kuapoa.limits")
print("bloco", e["min_block_size"], "..", e["max_block_size"], "B; blocos", e["min_block_count"], "..", e["max_block_count"],
      "; total máximo", lim["max_total_bytes"], "B; tipos", e["entropy_types"])'

echo "== 2. um bloco de 32 bytes"
curl -sS -X POST -H "$AUTH" -H "Content-Type: application/json" -d '{"block_size": 32}' "$BASE/entropy" | python3 -c '
import base64, json, sys
r = json.load(sys.stdin)
b = [base64.b64decode(x, validate=True) for x in r["entropy"]]
assert len(b) == 1 and len(b[0]) == 32, "fora do contrato"
print(len(b), "bloco de", len(b[0]), "bytes; início", b[0][:4].hex())'

echo "== 3. quatro blocos de 64 bytes (mesmo token por X-API-Key)"
curl -sS -X POST -H "X-API-Key: ${QRNG_API_TOKEN}" -H "Content-Type: application/json" \
  -d '{"block_size": 64, "block_count": 4, "entropy_type": "kuapoa_qrng"}' "$BASE/entropy" | python3 -c '
import base64, json, sys
r = json.load(sys.stdin)
b = [base64.b64decode(x, validate=True) for x in r["entropy"]]
assert len(b) == 4 and all(len(x) == 64 for x in b), "fora do contrato"
print(len(b), "blocos:", [len(x) for x in b])'

echo "== 4. saúde (observações atuais, com o instante de cada uma)"
curl -sS -H "$AUTH" "$BASE/healthtest" | python3 -c '
import json, sys
for t in json.load(sys.stdin)["test_result"]:
    print(" ", t["test_type"], "=", t["test_result"], "em", t["time_stamp"])'

echo "== 5. erros (código HTTP e código de erro)"
show() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ", d.get("error"), "-", d.get("message"))'; }
printf "  parâmetro inválido (string): HTTP %s\n" "$(curl -sS -o /tmp/qoa_err.json -w '%{http_code}' -X POST -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"block_size": "32"}' "$BASE/entropy")"; show < /tmp/qoa_err.json
printf "  sem token: HTTP %s\n" "$(curl -sS -o /tmp/qoa_err.json -w '%{http_code}' "$BASE/capabilities")"; show < /tmp/qoa_err.json
echo "  429 = limite por minuto ou cota diária (veja o cabeçalho Retry-After); 503 = fonte indisponível, nenhum bloco entregue"
rm -f /tmp/qoa_err.json
