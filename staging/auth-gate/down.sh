#!/usr/bin/env bash
# Derruba o kapua-authgate, remove os volumes (bancos de teste) e apaga os
# segredos de teste (.env). O próximo up.sh gera segredos novos.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
docker compose -p kapua-authgate -f docker-compose.yml down -v --remove-orphans
rm -f .env
echo "kapua-authgate removido (volumes e .env apagados)"
