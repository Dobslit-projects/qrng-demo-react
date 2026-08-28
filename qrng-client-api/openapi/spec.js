"use strict";

/**
 * Definição base da especificação OpenAPI do Kapuã QRNG.
 *
 * A especificação é GERADA a partir do código real: swagger-jsdoc escaneia
 * os blocos de comentário `@openapi` posicionados diretamente acima de cada
 * rota em server.js (item 9 da auditoria do pipeline QRNG — "sem
 * documentação manual divergente"). Este arquivo só define os metadados
 * compartilhados (info, servers, schemas reutilizáveis, esquema de auth) —
 * os paths em si vêm inteiramente dos comentários em server.js.
 *
 * Item 7 da auditoria: a spec ÚNICA anterior incluía as rotas /admin/* (tag
 * "Admin") no mesmo documento publicado publicamente em /v1/openapi.json,
 * sem autenticação -- um scanner anônimo conseguia enumerar a forma exata
 * da API administrativa sem nunca precisar de credenciais. Este arquivo
 * agora constrói UMA spec completa internamente e expõe duas visões
 * filtradas por tag:
 *   - buildPublicSpec(): tudo MENOS a tag "Admin", sem o server local de
 *     desenvolvimento (não faz sentido publicar um endereço 127.0.0.1 numa
 *     spec destinada a consumidores externos).
 *   - buildInternalAdminSpec(): SÓ a tag "Admin", mantém os dois servers.
 *     Nunca deve ser servida numa rota pública sem autenticação -- ver
 *     server.js, montada atrás de requireAuth+requireAdmin.
 *
 * Para regenerar as cópias estáticas versionadas: npm run openapi:generate
 * (escreve openapi/qrng-public-v1.yaml e openapi/qrng-internal-admin-v1.yaml).
 */

const swaggerJsdoc = require("swagger-jsdoc");
const path = require("path");

const definition = {
  openapi: "3.0.3",
  info: {
    title: "Kapuã QRNG — API Pública",
    version: "1.0.0",
    description:
      "API pública do gerador quântico de números aleatórios (QRNG) do Kapuã/Dobslit. " +
      "Fonte física: FPGA Red Pitaya, stream uint32 little-endian, sem conditioning " +
      "(confirmado no código-fonte do pipeline físico). " +
      "Bytes brutos são servidos sem processamento adicional; a avaliação de min-entropia " +
      "é feita separadamente pela suíte NIST SP 800-90B (ver aba Teste NIST / /qrng/nist/ " +
      "no frontend) — nenhum endpoint aqui certifica ou garante um nível de entropia.\n\n" +
      "Unidade de TRANSPORTE (o que esta API entrega): bytes brutos, tal como lidos do " +
      "registrador AXI FIFO da FPGA (4 bytes little-endian por amostra uint32). " +
      "Unidade de AVALIAÇÃO ESTATÍSTICA (o que a suíte NIST SP 800-90B mede sobre uma " +
      "amostra desses bytes): symbol width de 8 bits por decomposição byte a byte -- " +
      "ver assessment_symbol_width nos resultados de /nist/*. As duas unidades são " +
      "independentes: o formato de transporte não é uma alegação sobre quantos bits " +
      "têm significado físico nem sobre origem quântica comprovada -- isso é o que a " +
      "avaliação estatística separada existe para medir.",
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
          "Corpo retornado quando format=hex|base64|uint8 OU quando o parâmetro " +
          "format é omitido (default=hex). Para format=raw o corpo é " +
          "application/octet-stream com exatamente os N bytes brutos (sem este " +
          "JSON, sem prefixo, sem BOM) — ou use a rota dedicada GET /raw (e /public/raw).",
        properties: {
          request_id: { type: "string", example: "req_a383397963db4222" },
          source: { type: "string", example: "dobslit-qrng-ufpe-fpga", description: "Rótulo da fonte (env QRNG_SOURCE_LABEL)." },
          provenance: {
            type: "string",
            enum: ["live", "replay", "fixture", "historical", "fallback", "unknown"],
            example: "live",
            description: "Proveniência EFETIVA desta resposta (== provenance_detail.actual_origin). Resolvida por resposta: 'live' só com evidência do caminho live (upstream saudável, buffer saudável, amostra recente). Uma instância de replay/fixture/histórico nunca reporta 'live'. Também no header X-QRNG-Provenance quando format=raw.",
          },
          provenance_detail: { $ref: "#/components/schemas/ProvenanceDetail" },
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
        required: ["request_id", "source", "provenance", "provenance_detail", "bytes", "format", "random", "timestamp"],
      },
      ProvenanceDetail: {
        type: "object",
        description:
          "Contrato de proveniência POR RESPOSTA (item 3). Determina a origem efetiva " +
          "de cada resposta em vez de carimbar tudo pela configuração da instância. " +
          "Em respostas binárias (format=raw) os mesmos campos vão em headers " +
          "X-QRNG-Provenance / X-QRNG-Live-Verified / X-QRNG-Fallback-Used / " +
          "X-QRNG-Source-Health / X-QRNG-Buffer-Health / X-QRNG-Captured-At / " +
          "X-QRNG-Capture-Id / X-QRNG-Sample-Age-Ms / X-QRNG-Served-At.",
        properties: {
          configured_source: { type: "string", example: "fpga", description: "Fonte configurada da instância (env QRNG_CONFIGURED_SOURCE)." },
          instance_mode: { type: "string", enum: ["live", "replay", "fixture", "historical"], description: "Modo/capacidade da instância — teto: nunca eleva uma resposta acima do que pode provar." },
          actual_origin: { type: "string", enum: ["live", "fallback", "replay", "fixture", "historical", "unknown"], description: "Origem EFETIVA. 'live' só com evidência do caminho live. fallback/replay/historical nunca viram 'live'." },
          source_health: { type: "string", enum: ["healthy", "degraded", "failed", "unknown"] },
          buffer_health: { type: "string", enum: ["healthy", "degraded", "discontinuous", "unknown"] },
          captured_at: { type: "string", format: "date-time", nullable: true },
          served_at: { type: "string", format: "date-time" },
          sample_age_ms: { type: "integer", nullable: true },
          capture_id: { type: "string", nullable: true },
          fallback_used: { type: "boolean", description: "Prevalece sobre a configuração da instância — se true, actual_origin é sempre 'fallback'." },
          live_verified: { type: "boolean", description: "true só quando há evidência de captura (captured_at) confirmando o caminho live nesta resposta." },
        },
        required: ["configured_source", "actual_origin", "source_health", "buffer_health", "served_at", "fallback_used", "live_verified"],
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
      PayloadTooLarge: {
        description:
          "Corpo da requisição acima do limite de 8 KiB. Este serviço só " +
          "aceita corpos JSON pequenos (auth/admin); erro estruturado " +
          "(error=REQUEST_BODY_TOO_LARGE), nunca HTML/stack.",
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

/** Spec completa, TODAS as tags incluídas -- uso interno/teste apenas, nunca servida diretamente. */
function buildFullSpec() {
  return swaggerJsdoc(options);
}

/**
 * Filtra os paths de uma spec para manter só operações cuja tag bate com o
 * predicado. Remove também o path inteiro se, depois do filtro, nenhum
 * método restar nele (evita "/admin/tokens: {}" vazio na spec pública).
 */
function filterPathsByTag(spec, tagPredicate) {
  const filteredPaths = {};
  for (const [route, methods] of Object.entries(spec.paths || {})) {
    const keptMethods = {};
    for (const [verb, operation] of Object.entries(methods)) {
      const tags = operation.tags || [];
      if (tags.some(tagPredicate)) keptMethods[verb] = operation;
    }
    if (Object.keys(keptMethods).length > 0) filteredPaths[route] = keptMethods;
  }
  return filteredPaths;
}

/**
 * Spec pública (item 7): tudo MENOS a tag "Admin", sem o server local de
 * desenvolvimento. É esta que deve ser servida sem autenticação.
 */
function buildPublicSpec() {
  const full = buildFullSpec();
  return {
    ...full,
    info: {
      ...full.info,
      title: "Kapuã QRNG — API Pública",
    },
    servers: full.servers.filter((s) => !s.url.includes("127.0.0.1")),
    tags: full.tags.filter((t) => t.name !== "Admin"),
    paths: filterPathsByTag(full, (tag) => tag !== "Admin"),
  };
}

/**
 * Spec administrativa interna (item 7): SÓ a tag "Admin". Nunca deve ser
 * exposta numa rota pública sem autenticação -- ver server.js, montada
 * atrás de requireAuth+requireAdmin, nunca em /v1/openapi.json.
 */
function buildInternalAdminSpec() {
  const full = buildFullSpec();
  return {
    ...full,
    info: {
      ...full.info,
      title: "Kapuã QRNG — API Administrativa Interna",
      description:
        "Documentação da API administrativa (role=admin). NÃO É pública -- " +
        "requer sessão JWT com role=admin (ver bearerAuthJWT). Servida apenas " +
        "atrás de autenticação; nunca publicada num caminho anônimo.",
    },
    tags: full.tags.filter((t) => t.name === "Admin"),
    paths: filterPathsByTag(full, (tag) => tag === "Admin"),
  };
}

module.exports = {
  // Mantido por compatibilidade com quem já importava buildSpec -- é
  // deliberadamente a spec completa (equivalente a buildFullSpec), então
  // NUNCA deve ser montada diretamente numa rota pública sem filtrar.
  buildSpec: buildFullSpec,
  buildFullSpec,
  buildPublicSpec,
  buildInternalAdminSpec,
  definition,
};
