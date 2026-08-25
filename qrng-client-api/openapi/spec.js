"use strict";

/**
 * Definição base da especificação OpenAPI da API pública do Kuapoã QRNG.
 *
 * A especificação é GERADA a partir do código real: swagger-jsdoc escaneia
 * os blocos de comentário `@openapi` posicionados diretamente acima de cada
 * rota em server.js (item 9 da auditoria do pipeline QRNG — "sem
 * documentação manual divergente"). Este arquivo só define os metadados
 * compartilhados (info, servers, schemas reutilizáveis, esquema de auth) —
 * os paths em si vêm inteiramente dos comentários em server.js.
 *
 * Para regenerar a cópia estática versionada: npm run openapi:generate
 * (escreve openapi/qrng-public-v1.yaml a partir desta mesma definição).
 */

const swaggerJsdoc = require("swagger-jsdoc");
const path = require("path");

const definition = {
  openapi: "3.0.3",
  info: {
    title: "Kuapoã QRNG — API Pública",
    version: "1.0.0",
    description:
      "API pública do gerador quântico de números aleatórios (QRNG) do Kuapoã/Dobslit. " +
      "Fonte física: FPGA Red Pitaya, stream uint32 little-endian, sem conditioning " +
      "(confirmado no código-fonte do pipeline físico). " +
      "Bytes brutos são servidos sem processamento adicional; a avaliação de min-entropia " +
      "é feita separadamente pela suíte NIST SP 800-90B (ver aba Teste NIST / /qrng/nist/ " +
      "no frontend) — nenhum endpoint aqui certifica ou garante um nível de entropia.",
    contact: { name: "Dobslit" },
  },
  servers: [
    { url: "https://bongo.dobslit.com/qrng/v1", description: "Produção (via nginx, proxy para o client-api)" },
    { url: "http://127.0.0.1:3010/v1", description: "Local (client-api direto, sem nginx)" },
  ],
  tags: [
    { name: "Auth", description: "Registro, login e identidade do usuário" },
    { name: "Tokens", description: "Emissão, rotação e revogação de tokens de API pessoais" },
    { name: "Random", description: "Geração de bytes aleatórios (endpoint principal)" },
    { name: "Health", description: "Saúde da API e do upstream FPGA" },
    { name: "Usage", description: "Cota, uso e histórico de chamadas do token" },
    { name: "Admin", description: "Administração de tokens e usuários (role=admin)" },
  ],
  components: {
    securitySchemes: {
      bearerAuthJWT: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Sessão de usuário (login via /v1/auth/login ou /v1/auth/register). " +
          "Usada pelos endpoints /v1/auth/me, /v1/tokens e /v1/admin/*.",
      },
      bearerAuthToken: {
        type: "http",
        scheme: "bearer",
        description:
          "Token de API pessoal (formato dobslit_qrng_live_<hex>, emitido por POST /v1/tokens). " +
          "Usado pelos endpoints de consumo: /v1/random, /v1/health. " +
          "Endpoints /v1/me/* aceitam tanto este token quanto o JWT de sessão.",
      },
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        properties: {
          request_id: { type: "string", example: "req_a383397963db4222", nullable: true },
          error: { type: "string", example: "INVALID_TOKEN" },
          message: { type: "string", example: "Token inválido ou revogado." },
        },
        required: ["error"],
      },
      RandomResponse: {
        type: "object",
        description:
          "Corpo retornado quando format=hex|base64|uint8. Para format=binary " +
          "(ou omitido, dependendo da rota — ver cada endpoint), o corpo é " +
          "application/octet-stream com os bytes brutos, não este JSON.",
        properties: {
          request_id: { type: "string", example: "req_a383397963db4222" },
          source: { type: "string", example: "dobslit-qrng-ufpe-fpga" },
          bytes: { type: "integer", example: 32, description: "Quantidade de bytes gerados." },
          format: { type: "string", enum: ["hex", "base64", "uint8"], example: "hex" },
          random: {
            description: "hex: string hexadecimal (2N caracteres). base64: string base64. uint8: array de N inteiros [0,255].",
            oneOf: [
              { type: "string", example: "5c0eda118fdf680778ecf97c4ab89cb7" },
              { type: "array", items: { type: "integer", minimum: 0, maximum: 255 } },
            ],
          },
          timestamp: { type: "string", format: "date-time" },
        },
        required: ["request_id", "source", "bytes", "format", "random", "timestamp"],
      },
      AuthResponse: {
        type: "object",
        properties: {
          token: { type: "string", description: "JWT de sessão, válido por 30 dias." },
          email: { type: "string", format: "email" },
          role: { type: "string", enum: ["user", "admin"] },
        },
        required: ["token", "email", "role"],
      },
      TokenInfo: {
        type: "object",
        properties: {
          has_token: { type: "boolean" },
          token_prefix: { type: "string", example: "dobslit_qrng_live_a1b2c3d4" },
          name: { type: "string" },
          status: { type: "string", enum: ["active", "revoked"] },
          quota_daily: { type: "integer" },
          requests_today: { type: "integer" },
          bytes_today: { type: "integer" },
          created_at: { type: "string", format: "date-time" },
          last_used_at: { type: "string", format: "date-time", nullable: true },
        },
      },
      TokenIssued: {
        type: "object",
        description: "Retornado apenas na criação/rotação — o token completo NUNCA é exibido novamente.",
        properties: {
          message: { type: "string" },
          token: { type: "string", example: "dobslit_qrng_live_<40 hex chars>" },
          prefix: { type: "string" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      UsageResponse: {
        type: "object",
        properties: {
          has_token: { type: "boolean" },
          token_name: { type: "string" },
          status: { type: "string" },
          quota_daily_requests: { type: "integer" },
          quota_daily_bytes: { type: "integer" },
          max_bytes_per_request: { type: "integer" },
          requests_today: { type: "integer" },
          bytes_today: { type: "integer" },
          remaining_requests_today: { type: "integer" },
          remaining_bytes_today: { type: "integer" },
          requests_7d: { type: "integer" },
          bytes_7d: { type: "integer" },
          requests_30d: { type: "integer" },
          bytes_30d: { type: "integer" },
          last_used_at: { type: "string", format: "date-time", nullable: true },
          daily_history: {
            type: "array",
            items: {
              type: "object",
              properties: {
                date: { type: "string", format: "date" },
                requests_count: { type: "integer" },
                bytes_count: { type: "integer" },
                errors_count: { type: "integer" },
              },
            },
          },
        },
      },
      RequestLogEntry: {
        type: "object",
        properties: {
          request_id: { type: "string" },
          endpoint: { type: "string" },
          bytes_requested: { type: "integer" },
          format: { type: "string", nullable: true },
          status_code: { type: "integer" },
          ip_address: { type: "string" },
          duration_ms: { type: "integer", nullable: true },
          created_at: { type: "string", format: "date-time" },
        },
      },
      HealthSelfResponse: {
        type: "object",
        properties: {
          status: { type: "string", example: "ok" },
          service: { type: "string", example: "qrng-client-api" },
          uptime_seconds: { type: "number" },
          timestamp: { type: "string", format: "date-time" },
        },
      },
      HealthResponse: {
        type: "object",
        description: "Requer token. `upstream` é a resposta bruta do broker FPGA (ver /health no server_api.py upstream — buffer_bytes_available, source_status, stream_format, sample_width_bytes, conditioned).",
        properties: {
          request_id: { type: "string" },
          status: { type: "string", example: "ok" },
          api: { type: "string", example: "dobslit-qrng-client-api" },
          source: { type: "string", example: "ufpe-fpga" },
          upstream: { type: "object", additionalProperties: true },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: "Token ausente, inválido ou expirado.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
      },
      Forbidden: {
        description: "Autenticado, mas sem permissão (ex.: rota de admin sem role=admin).",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
      },
      RateLimited: {
        description: "Limite de requisições por IP ou por token excedido.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        headers: {
          "Retry-After": { schema: { type: "integer" }, description: "Segundos até poder tentar novamente." },
        },
      },
      QuotaExceeded: {
        description: "Cota diária de requisições ou bytes excedida.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
      },
      UpstreamError: {
        description: "Upstream FPGA indisponível, com formato inesperado, ou timeout.",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
      },
    },
  },
};

const options = {
  definition,
  apis: [path.join(__dirname, "..", "server.js")],
};

module.exports = { buildSpec: () => swaggerJsdoc(options), definition };
