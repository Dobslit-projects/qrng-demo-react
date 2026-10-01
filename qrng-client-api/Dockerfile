# Dockerfile de deploy (fora do repositorio) para o qrng-client-api.
# Na VM antiga este servico roda direto via systemd + node; aqui e
# containerizado para nao exigir Node.js instalado no host, seguindo o
# mesmo padrao ja usado para o bongosite-auth.
FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY openapi ./openapi
COPY vendor ./vendor
COPY scripts ./scripts

# Persistencia do SQLite fora do filesystem do container, igual ao
# padrao usado no bongosite-auth. DB_PATH fica na IMAGEM: entre 2026-09-18 e
# 2026-10-01 um deploy perdeu a variavel e o servico gravou num banco efemero
# dentro do container (contas inacessiveis, cadastros apagados a cada deploy).
VOLUME ["/data"]
ENV DB_PATH=/data/qrng-tokens.db

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3010}/v1/health/self" >/dev/null || exit 1

CMD ["node", "server.js"]
