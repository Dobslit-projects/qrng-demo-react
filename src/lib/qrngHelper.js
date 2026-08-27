import { API_ROUTES, CLIENT_API, getAuthHeaders } from "../qrngApi";
import { QRNG_PRECOLLECTED, QRNG_PRECOLLECTED_PROVENANCE } from "../qrngFallbackData";

/**
 * Adaptador canônico de bytes QRNG (item 3 da auditoria do pipeline).
 *
 * Este módulo é o ÚNICO ponto do frontend que decodifica a resposta HTTP da
 * API QRNG (validação de schema, conversão hex → Uint8Array) e o único que
 * implementa rejection sampling para inteiros/faixas. Antes desta
 * consolidação existiam três adaptadores paralelos com nomes quase
 * idênticos (fetchQrngBytes aqui, fetchQRNGBytes em qrngApi.js,
 * generateQRNGSequence em qrngHelpers.js) com lógicas de decodificação,
 * tratamento de erro e vieses estatísticos diferentes entre si.
 *
 * Duas rotas de rede coexistem hoje, propositalmente preservadas por esta
 * consolidação (mudar QUAL rota cada consumidor usa é uma decisão de
 * segurança/arquitetura separada, fora do escopo de um refactor mecânico):
 *   - fetchQrngBytes(count, source): usada pelas páginas centrais
 *     (Representações Visuais, Dados, Kapuã) — respeita a fonte escolhida
 *     em Configurações (remote/fpga/pre-collected) via API_ROUTES.
 *   - fetchQrngBytesViaToken(count): usada pelas aplicações da aba
 *     "Aplicações" (Dado, Moeda, Loteria, Bitmap, Seed, Monte Carlo Pi,
 *     Teste de Previsibilidade) — sempre autenticada via token pessoal
 *     (CLIENT_API), pois esses componentes não oferecem seletor de fonte.
 *
 * ATENÇÃO (achado da auditoria, não corrigido aqui): fetchQrngBytes()
 * atinge /qrng/api/ e /qrng/api-fpga/, que o nginx expõe SEM exigir o
 * cookie de sessão do Bongo nem qualquer token -- confirmado publicamente
 * acessível (HTTP 200 sem autenticação) em 2026-08-25. fetchQrngBytesViaToken()
 * atinge /qrng/v1/, que exige token (401 sem ele) e tem cota/rate-limit.
 * Fechar ou proteger o primeiro caminho é uma mudança de produção/nginx
 * que requer autorização explícita separada -- ver relatório de auditoria.
 */

// ─── Fallback pré-coletado (finito, SEM wraparound — item 4 da auditoria) ───
//
// Antes: o cursor avançava com módulo (`% PRECOLLECTED_LIMIT`), reciclando o
// mesmo buffer de 10.000 bytes silenciosamente e para sempre -- nenhum
// consumidor tinha como saber que os "novos" bytes pedidos eram, na
// verdade, uma repetição exata de bytes já entregues antes na mesma sessão.
// Agora: o cursor avança sem wraparound; pedir mais bytes do que restam
// lança PrecollectedExhaustedError (o chamador já propaga exceções da fonte
// QRNG normalmente -- ver generateQrngSequence). Reiniciar a demonstração é
// uma ação explícita do usuário (resetPrecollectedCursor), nunca implícita.

/** Total de bytes disponíveis no buffer pré-coletado local. */
export const PRECOLLECTED_LIMIT = QRNG_PRECOLLECTED.length;

let fallbackOffset = 0;
const precollectedListeners = new Set();

function notifyPrecollectedListeners() {
  const remaining = PRECOLLECTED_LIMIT - fallbackOffset;
  precollectedListeners.forEach((fn) => fn(remaining));
}

/** Assina mudanças no cursor do fallback (para banners/indicadores reativos). Retorna função de unsubscribe. */
export function onPrecollectedChange(fn) {
  precollectedListeners.add(fn);
  return () => precollectedListeners.delete(fn);
}

/** Bytes restantes no buffer pré-coletado antes de esgotar (sem reset). */
export function precollectedRemaining() {
  return PRECOLLECTED_LIMIT - fallbackOffset;
}

/**
 * Reinicia o cursor do fallback para 0 -- ação EXPLÍCITA do usuário
 * ("Reiniciar demonstração" na UI). Isto reaproveita exatamente os mesmos
 * 10.000 bytes já usados antes na sessão, não gera uma amostra nova; a UI
 * que chama isto deve deixar esse aviso visível (item 4).
 */
export function resetPrecollectedCursor() {
  fallbackOffset = 0;
  notifyPrecollectedListeners();
}

export class PrecollectedExhaustedError extends Error {
  constructor(requested, remaining) {
    super(
      `Buffer pré-coletado esgotado: restam ${remaining} de ${PRECOLLECTED_LIMIT} bytes, ` +
      `foram pedidos ${requested}. Use "Reiniciar demonstração" para reciclar os mesmos ` +
      `${PRECOLLECTED_LIMIT} bytes (não é uma nova amostra) ou troque para uma fonte QRNG ao vivo.`
    );
    this.name = "PrecollectedExhaustedError";
    this.requested = requested;
    this.remaining = remaining;
  }
}

function getPrecollectedBytes(byteCount) {
  const t0 = performance.now();
  const remaining = PRECOLLECTED_LIMIT - fallbackOffset;
  if (byteCount > remaining) {
    throw new PrecollectedExhaustedError(byteCount, remaining);
  }
  const bytes = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i++) {
    bytes[i] = QRNG_PRECOLLECTED[fallbackOffset + i];
  }
  fallbackOffset += byteCount;
  notifyPrecollectedListeners();
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return {
    bytes, hex,
    source: "pré-coletado",
    requestId: null,
    timestamp: new Date().toISOString(),
    latencyMs: Math.round(performance.now() - t0),
    remaining: PRECOLLECTED_LIMIT - fallbackOffset,
    provenance: QRNG_PRECOLLECTED_PROVENANCE,
  };
}

// ─── Decodificação canônica da resposta HTTP ────────────────────────────────

function decodeQrngJsonResponse(json, t0) {
  const hex = json.random || json.hex || "";
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return {
    bytes, hex,
    source:    json.source    ?? json.generator ?? null,
    requestId: json.request_id ?? json.id       ?? null,
    timestamp: json.timestamp  ?? new Date().toISOString(),
    latencyMs: Math.round(performance.now() - t0),
  };
}

/**
 * Busca N bytes da fonte QRNG ativa (Configurações: remote/fpga/pre-collected).
 * Usada pelas páginas centrais (Representações Visuais, Dados, Kapuã).
 */
export async function fetchQrngBytes(byteCount, source = "remote") {
  if (source === "pre-collected") {
    return getPrecollectedBytes(byteCount);
  }
  const apiPrefix = API_ROUTES[source] || API_ROUTES.remote;
  const t0 = performance.now();
  const r = await fetch(`${apiPrefix}/random?bytes=${byteCount}&format=hex`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail || body.error || body.message || `QRNG API error ${r.status}`);
  }
  const json = await r.json();
  return decodeQrngJsonResponse(json, t0);
}

/**
 * Busca N bytes via token de API pessoal (client-api /v1/random, autenticado,
 * com cota e rate-limit). Usada pelas aplicações da aba "Aplicações", que
 * não oferecem seletor de fonte remote/fpga/pre-collected.
 */
export async function fetchQrngBytesViaToken(byteCount) {
  const t0 = performance.now();
  const r = await fetch(`${CLIENT_API}/random?bytes=${byteCount}&format=hex`, {
    headers: getAuthHeaders(),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message || body.error || `QRNG API error ${r.status}`);
  }
  const json = await r.json();
  return decodeQrngJsonResponse(json, t0);
}

// ─── Modo binário real (item 2 da estabilização) ──────────────────────────
//
// Antes: o modo "Raw Binário" da aba Dados e o download .bin baixavam
// `?format=hex` e desempacotavam a string hex no cliente (2× o tráfego, e
// não era binário de verdade vindo da API). Agora usam `?format=raw`, que a
// API entrega como application/octet-stream com EXATAMENTE os N bytes
// (Content-Length = N), sem JSON/prefixo/BOM. hex/uint8/range/montecarlo
// continuam usando fetchQrngBytes()/fetchQrngBytesViaToken() (JSON hex),
// intocados -- nenhum consumidor existente muda de comportamento.

function decodeRawResponse(buf, r, t0) {
  const bytes = new Uint8Array(buf);
  return {
    bytes,
    hex: bytesToHex(bytes),
    source:      r.headers.get("x-qrng-source") || null,
    requestId:   r.headers.get("x-request-id") || null,
    conditioned: r.headers.get("x-qrng-conditioned"), // string "false" quando presente
    timestamp:   new Date().toISOString(),
    latencyMs:   Math.round(performance.now() - t0),
  };
}

/** N bytes da fonte ativa em binário real (application/octet-stream). Pré-coletada: buffer local. */
export async function fetchQrngRawBytes(byteCount, source = "remote") {
  if (source === "pre-collected") {
    return getPrecollectedBytes(byteCount);
  }
  const apiPrefix = API_ROUTES[source] || API_ROUTES.remote;
  const t0 = performance.now();
  const r = await fetch(`${apiPrefix}/random?bytes=${byteCount}&format=raw`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail || body.error || body.message || `QRNG API error ${r.status}`);
  }
  return decodeRawResponse(await r.arrayBuffer(), r, t0);
}

/** N bytes em binário real via token pessoal (client-api /v1/random?format=raw). */
export async function fetchQrngRawBytesViaToken(byteCount) {
  const t0 = performance.now();
  const r = await fetch(`${CLIENT_API}/random?bytes=${byteCount}&format=raw`, {
    headers: getAuthHeaders(),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.message || body.error || `QRNG API error ${r.status}`);
  }
  return decodeRawResponse(await r.arrayBuffer(), r, t0);
}

// ─── Conversões derivadas (bytes → hex / uint32 / float / int) ─────────────

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function bytesToUint32Array(bytes) {
  const out = [];
  for (let i = 0; i + 3 < bytes.length; i += 4)
    out.push(((bytes[i] << 24) | (bytes[i+1] << 16) | (bytes[i+2] << 8) | bytes[i+3]) >>> 0);
  return out;
}

export function uint32ToFloat(n) { return n / 4294967296; }

/**
 * Transforma um float uniforme U em [0,1) (ver uint32ToFloat) em uma amostra
 * de distribuição exponencial de média `mean`, via método da transformada
 * inversa: X = -mean * ln(1 - U). U nunca é exatamente 1 (uint32ToFloat de
 * 0xFFFFFFFF = 0.9999999997671694 < 1), então ln(1 - U) é sempre finito.
 */
export function exponentialFromUniform(u, mean) {
  return -mean * Math.log(1 - u);
}

/**
 * Normaliza bytes para [0,1) dividindo por 255 -- uma quantização DISCRETA
 * de apenas 256 níveis, não um float contínuo. Não é o mesmo método usado
 * pelo Monte Carlo real (uint32 ÷ 2^32, resolução ~2,3×10⁻¹⁰ -- ver
 * genMonteCarlo em DataSection.jsx). Usada hoje só pela Análise Estatística
 * (Scatter Plot / Distribuição / Bits, comparação PRNG×QRNG), que já é
 * consistente ponta a ponta (o PRNG de comparação também produz floats de
 * mesma resolução) -- mas não deve ser confundida nem reaproveitada como
 * substituto do Monte Carlo contínuo.
 */
export function bytesToDiscreteFloats(bytes) {
  return Array.from(bytes, (b) => b / 255);
}

/** Rejection-sampling: um inteiro uniforme em [min, max] a partir de bytes. */
export function uniformIntFromBytes(min, max, bytes) {
  const range = max - min + 1;
  const limit = (Math.floor(4294967296 / range)) * range;
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const n = ((bytes[i] << 24) | (bytes[i+1] << 16) | (bytes[i+2] << 8) | bytes[i+3]) >>> 0;
    if (n < limit) return min + (n % range);
  }
  return min + (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0) % range;
}

/**
 * Rejection-sampling: até `count` inteiros uniformes em [min, max], 4 bytes
 * por candidato. Substitui o padrão anterior "1 byte % range" (viés de
 * módulo confirmado -- ex.: range=100 favorecia os valores 0-55 em 3/256
 * vs. 2/256 para 56-99). Se `bytes` não tiver candidatos suficientes após
 * rejeições, retorna menos que `count` valores -- o chamador deve pedir
 * bytes suficientes (ver fetchQrngRandIntsViaToken).
 */
export function uniformIntsFromBytes(bytes, min, max, count) {
  const range = max - min + 1;
  const limit = Math.floor(4294967296 / range) * range;
  const out = [];
  for (let i = 0; i + 3 < bytes.length && out.length < count; i += 4) {
    const n = ((bytes[i] << 24) | (bytes[i+1] << 16) | (bytes[i+2] << 8) | bytes[i+3]) >>> 0;
    if (n < limit) out.push(min + (n % range));
  }
  return out;
}

/**
 * Sorteia um único inteiro uniforme em [min, max] via token de API pessoal,
 * com rejection sampling sobre uint32 (sem viés de módulo). Busca lotes de
 * candidatos por requisição para reduzir chamadas extras.
 */
export async function fetchQrngRandIntViaToken(min, max) {
  const t0 = performance.now();
  const range = max - min + 1;
  if (!Number.isInteger(range) || range < 1 || range > 4294967296) {
    throw new Error(`QRNG randint: faixa inválida [${min}, ${max}]`);
  }
  const limit = Math.floor(4294967296 / range) * range;

  for (let attempt = 0; attempt < 8; attempt++) {
    const { bytes } = await fetchQrngBytesViaToken(32); // 8 candidatos uint32
    for (let i = 0; i + 3 < bytes.length; i += 4) {
      const n = ((bytes[i] << 24) | (bytes[i+1] << 16) | (bytes[i+2] << 8) | bytes[i+3]) >>> 0;
      if (n < limit) {
        return { value: min + (n % range), latencyMs: Math.round(performance.now() - t0) };
      }
    }
  }
  throw new Error("QRNG randint: rejection sampling não convergiu após múltiplas tentativas");
}

/**
 * Sorteia `count` inteiros uniformes em [min, max] via token de API pessoal,
 * numa única requisição sobre-provisionada (4 bytes por candidato + margem
 * para rejeições). Substitui o padrão "1 byte % range" usado antes em
 * PredictabilityTest.
 */
export async function fetchQrngRandIntsViaToken(min, max, count) {
  const needed = Math.max(count * 4 + 16, 32); // margem para rejeições (tipicamente ~nenhuma)
  const result = await fetchQrngBytesViaToken(needed);
  const values = uniformIntsFromBytes(result.bytes, min, max, count);
  return { values, latencyMs: result.latencyMs };
}

// ─── Sequência QRNG para a Análise Estatística (PRNG × QRNG) ───────────────

/**
 * Gera uma sequência de `count` floats [0,1) (256 níveis discretos, ver
 * bytesToDiscreteFloats) usando a fonte QRNG ativa. NÃO faz fallback
 * silencioso em caso de erro -- propaga a exceção para o chamador, que deve
 * mostrar um estado de erro explícito (mesmo padrão de DataSection.jsx) em
 * vez de substituir invisivelmente por dados pré-coletados rotulados como
 * se fossem a fonte pedida.
 */
export async function generateQrngSequence(count, source = "remote") {
  if (source === "pre-collected") {
    const { bytes, latencyMs } = getPrecollectedBytes(count);
    return { values: bytesToDiscreteFloats(bytes), source: "pre-collected", latencyMs };
  }
  const { bytes, latencyMs } = await fetchQrngBytes(count, source);
  return { values: bytesToDiscreteFloats(bytes), source, latencyMs };
}

// ─── Mensagens de erro amigáveis ────────────────────────────────────────────

export function errorMessage(err) {
  const msg = err?.message || "";
  if (!msg) return "Backend QRNG indisponível. Verifique a conexão e tente novamente.";
  if (msg.includes("QRNG_UNAVAILABLE"))
    return "QRNG indisponível no momento (túnel FPGA offline). Tente novamente em alguns segundos ou use a fonte Pré-coletada.";
  if (msg.includes("502") || msg.includes("503"))
    return "Backend QRNG inacessível (502/503). O serviço pode estar reiniciando. Tente novamente em breve.";
  if (msg.includes("504") || msg.includes("timeout") || msg.toLowerCase().includes("timeout"))
    return "Tempo limite atingido aguardando dados QRNG. O hardware pode estar gerando entropia — tente novamente.";
  if (msg.includes("aborted") || msg.includes("AbortError") || err?.name === "AbortError")
    return "Requisição cancelada por tempo limite. Tente novamente.";
  if (msg.includes("404"))
    return "Endpoint QRNG não encontrado (404). Verifique a configuração da fonte.";
  if (msg.includes("401") || msg.includes("403"))
    return "Sem autorização para acessar a API QRNG. Verifique o token de acesso.";
  return msg;
}
