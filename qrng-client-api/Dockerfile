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
COPY test ./test

# Persistencia do SQLite fora do filesystem do container, igual ao
# padrao usado no bongosite-auth.
VOLUME ["/data"]

EXPOSE 3010

CMD ["node", "server.js"]
