#!/usr/bin/env bash
# Sobe o staging E2E reproduzivel e imprime o MANIFESTO de versao.
# Rodar da RAIZ do repositorio.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -p kapua-staging -f staging/docker-compose.staging.yml"
COMMIT="$(git rev-parse HEAD)"
DIRTY="$(git status --porcelain | wc -l | tr -d ' ')"

echo "== build =="
$COMPOSE build
echo "== up =="
$COMPOSE up -d

echo "== aguardando health =="
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${STAGING_WEB_PORT:-18080}/qrng/v1/health/self" >/dev/null 2>&1; then break; fi
  sleep 2
done

echo
echo "================ MANIFESTO STAGING kapua-staging ================"
echo "commit           : $COMMIT   (arvore suja: $DIRTY arquivos)"
echo "build_date       : $(date -u +%FT%TZ)"
echo "web_port         : 127.0.0.1:${STAGING_WEB_PORT:-18080}"
echo "provenance        : replay (fixture-upstream, seed 20260827) -- NUNCA live"
echo
echo "--- servicos / imagens / hashes ---"
$COMPOSE images --format json 2>/dev/null || $COMPOSE images
for svc in fixture-upstream qrng-client-api web; do
  img="kapua-staging-${svc}:local"
  id="$(docker image inspect "$img" --format '{{.Id}}' 2>/dev/null || echo '?')"
  echo "$svc  image=$img  id=$id"
done
echo
echo "--- portas / endpoints ---"
$COMPOSE ps
echo "portal    : http://127.0.0.1:${STAGING_WEB_PORT:-18080}/qrng/"
echo "openapi   : http://127.0.0.1:${STAGING_WEB_PORT:-18080}/qrng/v1/openapi.json"
echo "swagger   : http://127.0.0.1:${STAGING_WEB_PORT:-18080}/qrng/v1/docs/"
echo "redoc     : http://127.0.0.1:${STAGING_WEB_PORT:-18080}/qrng/v1/redoc"
echo "health    : http://127.0.0.1:${STAGING_WEB_PORT:-18080}/qrng/v1/health/self"
echo "public rnd: http://127.0.0.1:${STAGING_WEB_PORT:-18080}/qrng/api/random"
echo
echo "--- persistencia ---"
echo "SQLite     : volume kapua-staging-client-api-data -> /data/staging.db (NAO e o db de producao)"
echo "==============================================================="
