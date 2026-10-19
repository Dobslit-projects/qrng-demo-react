#!/usr/bin/env bash
# Teste de rollback/roll-forward entre a versão de PRODUÇÃO e a versão CANDIDATA
# (doc 155), sobre os MESMOS bancos SQLite:
#   0. produção cria o banco e recebe dados (como hoje);
#   1. candidata sobe → migração v1 com cópia prévia; dados preservados;
#   2. ROLLBACK: produção sobe de novo sobre o banco migrado e continua funcionando;
#   3. roll-forward: candidata de novo → nada a migrar, dados do passo 2 visíveis.
# Nada de produção é tocado: tudo roda em /tmp com portas locais.
#
# Uso (Linux/WSL, Node 20, git, rsync):
#   BONGO_REPO=<checkout do bongosite com a candidata> bash staging/rollback-compat/run.sh
# Opcionais: QRNG_PROD (padrão bcb5052), BONGO_PROD (padrão aa22bfb),
#   QRNG_GIT_DIR / BONGO_GIT_DIR (repositório onde estão esses commits, se o
#   checkout for um worktree cujo .git aponta para outro sistema).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QRNG_REPO="$(cd "$HERE/../.." && pwd)"
BONGO_REPO="${BONGO_REPO:?defina BONGO_REPO com o checkout do bongosite (versão candidata)}"
QRNG_PROD="${QRNG_PROD:-bcb5052}"
BONGO_PROD="${BONGO_PROD:-aa22bfb}"
QRNG_GIT_DIR="${QRNG_GIT_DIR:-$QRNG_REPO}"
BONGO_GIT_DIR="${BONGO_GIT_DIR:-$BONGO_REPO}"

W="$(mktemp -d /tmp/rollback-compat.XXXXXX)"
cleanup() { case "$W" in /tmp/rollback-compat.*) rm -rf -- "$W" ;; esac; }
trap cleanup EXIT

echo "== cópias: candidata (árvore de trabalho) e produção ($QRNG_PROD / $BONGO_PROD) =="
rsync -a --exclude node_modules --exclude '*.db' --exclude '*.db-*' "$QRNG_REPO/qrng-client-api/" "$W/qrng-cand/"
rsync -a --exclude node_modules --exclude '*.db' --exclude '*.db-*' "$BONGO_REPO/back/auth-api/" "$W/bongo-cand/"
mkdir -p "$W/x1" "$W/x2"
git -C "$QRNG_GIT_DIR" archive "$QRNG_PROD" qrng-client-api | tar -x -C "$W/x1"
git -C "$BONGO_GIT_DIR" archive "$BONGO_PROD" back/auth-api | tar -x -C "$W/x2"
mv "$W/x1/qrng-client-api" "$W/qrng-prod"
mv "$W/x2/back/auth-api" "$W/bongo-prod"

echo "== dependências (npm ci --omit=dev) =="
for d in qrng-cand qrng-prod bongo-cand bongo-prod; do
  (cd "$W/$d" && npm ci --omit=dev --no-audit --no-fund > "$W/npm-$d.log" 2>&1) || { echo "npm ci falhou em $d"; tail -20 "$W/npm-$d.log"; exit 1; }
done

node "$HERE/rollback-compat.mjs" "$W"
