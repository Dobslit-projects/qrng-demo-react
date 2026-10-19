#!/usr/bin/env bash
# Verificações OFFLINE do ambiente (não sobe nada):
#   1. render-nginx.py --check  (config renderizada = produção corrigida + adaptações)
#   2. nginx -t da config renderizada num nginx:1.24 (nomes de serviço → 127.0.0.1)
#   3. docker compose config    (com segredos fictícios só para interpolar)
#   4. links de redefinição de senha → página pública do portal (fora de /qrng/)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

python3 render-nginx.py --check

docker run --rm --network none \
  --add-host bongosite-auth:127.0.0.1 --add-host qrng-client-api:127.0.0.1 \
  --add-host fixture-upstream:127.0.0.1 --add-host stubs:127.0.0.1 \
  -v "$PWD/nginx/rendered/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$PWD/nginx/rendered/kuapoa-limits.conf:/etc/nginx/conf.d/00-kuapoa-limits.conf:ro" \
  -v "$PWD/stubs/edu:/var/www/edu:ro" \
  nginx:1.24 nginx -t 2>&1 | grep -E '^nginx:'

CFG="$(env AUTHGATE_BONGO_JWT_SECRET=x AUTHGATE_ADMIN_SEED_PASSWORD=x AUTHGATE_INTERNAL_SERVICE_TOKEN=x \
    AUTHGATE_MAIL_OUTBOX_KEY=x AUTHGATE_AUDIT_PSEUDONYM_KEY=x AUTHGATE_CLIENT_API_JWT_SECRET=x \
    docker compose --env-file /dev/null -f docker-compose.yml config)"
echo "compose config: OK"
# O link legado (client-api) e o fallback do Bongo precisam abrir a página PÚBLICA do
# front do portal: sob /qrng/ o gate manda o anônimo / a conta sem qrng para
# login/cards e o #token= se perde (README, "Recuperação de senha").
for v in QRNG_PASSWORD_RESET_URL QRNG_LEGACY_RESET_PATH; do
  val="$(printf '%s\n' "$CFG" | sed -n "s/^ *$v: *//p" | tr -d "\"'")"
  case "$val" in
    ""|*/qrng/*|*/qrng) echo "$v inválido: '${val:-ausente}' (precisa ser página pública fora de /qrng/)" >&2; exit 1 ;;
  esac
  echo "$v: $val"
done
for d in "${BONGO_AUTH_DIR:-../../../Bongo/bongosite-wt-auth/back/auth-api}" ../../qrng-client-api ../fixture-upstream; do
  test -f "$d/Dockerfile" || { echo "contexto de build ausente: $d" >&2; exit 1; }
  echo "contexto de build: $(cd "$d" && pwd)"
done
