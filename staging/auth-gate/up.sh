#!/usr/bin/env bash
# Sobe o ambiente de teste do gate de autorização (projeto kapua-authgate).
#   1. gera .env com segredos SÓ DE TESTE (se ainda não existir; down.sh apaga)
#   2. renderiza o nginx a partir da config de produção corrigida
#   3. build + up --wait (healthchecks de todos os serviços)
# Requisitos: docker compose v2, python3, openssl. Nada de produção é usado.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

COMPOSE=(docker compose -p kapua-authgate -f docker-compose.yml)

if [ ! -s .env ]; then
  umask 077
  {
    echo "# SEGREDOS SÓ DE TESTE do kapua-authgate — gerados por up.sh em $(date -u +%FT%TZ)."
    echo "# Nunca reutilize em outro ambiente. down.sh apaga este arquivo."
    echo "AUTHGATE_BONGO_JWT_SECRET=$(openssl rand -hex 32)"
    echo "AUTHGATE_CLIENT_API_JWT_SECRET=$(openssl rand -hex 32)"
    echo "AUTHGATE_INTERNAL_SERVICE_TOKEN=$(openssl rand -hex 32)"
    echo "AUTHGATE_MAIL_OUTBOX_KEY=$(openssl rand -base64 32)"
    echo "AUTHGATE_AUDIT_PSEUDONYM_KEY=$(openssl rand -hex 32)"
    echo "AUTHGATE_ADMIN_SEED_PASSWORD=Seed$(openssl rand -hex 12)x9"
  } > .env
  echo "== .env gerado (segredos de teste; valores não impressos) =="
fi

python3 render-nginx.py

echo "== build + up =="
"${COMPOSE[@]}" up -d --build --wait --wait-timeout 300

echo
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
echo
echo "gate     : http://127.0.0.1:${AUTHGATE_PORT:-18180}/qrng/"
echo "portal   : http://127.0.0.1:${AUTHGATE_PORT:-18180}/   (stub do front; API real em /api/)"
echo "matriz   : node run-matrix.mjs   (ver README.md)"
