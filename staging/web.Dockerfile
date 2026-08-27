# Frontend do STAGING E2E: mesma build de producao, servido sob /qrng com o
# nginx.staging-e2e.conf (rotas apontando para os servicos do compose).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html/qrng
COPY staging/nginx.staging-e2e.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
