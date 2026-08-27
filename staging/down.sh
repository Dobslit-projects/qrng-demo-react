#!/usr/bin/env bash
# Derruba o staging E2E e (com -v) remove o volume de dados.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -p kapua-staging -f staging/docker-compose.staging.yml down "${@:-}"
