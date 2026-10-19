"use strict";

/**
 * Cliente das APIs INTERNAS do Bongo (autoridade de identidade e fila de
 * e-mail central) — doc 155, seções 0, 2.1 e 3.
 *
 *   POST {BONGO_INTERNAL_URL}/api/internal/v1/introspect   {token, reauthToken?, reauthPurpose?}
 *   POST {BONGO_INTERNAL_URL}/api/internal/v1/mail         {template, to, locale, secret, secretExpiresAt,
 *                                                            idempotencyKey, validity:{kind, ref}}
 *   POST {BONGO_INTERNAL_URL}/api/internal/v1/mail/cancel  {validity:{kind, refs:[...]}}
 *   POST {BONGO_INTERNAL_URL}/api/internal/v1/accounts/status {ids:[...]}
 * todos com `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
 *
 * A client-api NÃO recebe a chave de assinatura dos JWTs do Bongo: quem
 * valida a sessão do portal é o próprio Bongo (introspecção).
 *
 * Falha FECHADA: Bongo inacessível, 5xx, timeout, resposta malformada ou
 * INTERNAL_SERVICE_TOKEN ausente → IdentityUnavailableError (a rota responde
 * 503 IDENTITY_UNAVAILABLE). Nada é concedido por cache vencido.
 *
 * Cache da introspecção: indexado pelo SHA-256 do token (o token em si nunca
 * é guardado), por no máximo `cacheMs`. Só respostas 200 bem-formadas entram
 * no cache; falhas nunca. Chamadas com `reauthToken` nunca usam nem alimentam
 * o cache (o reauth é de uso único e consumido pelo Bongo).
 */

const crypto = require("crypto");
const http = require("http");
const nodeFetch = require("node-fetch");

class IdentityUnavailableError extends Error {
  constructor(code) {
    super(`identidade indisponível (${code})`);
    this.name = "IdentityUnavailableError";
    this.code = code;
  }
}

class MailEnqueueError extends Error {
  constructor(code) {
    super(`fila de e-mail indisponível (${code})`);
    this.name = "MailEnqueueError";
    this.code = code;
  }
}

function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }

/**
 * @param {{ baseUrl: string, serviceToken: string|null, timeoutMs: number, cacheMs: number,
 *           fetchImpl?: Function, maxCacheEntries?: number, now?: () => number }} cfg
 *   `now` = relógio em ms (padrão Date.now), injetável para os testes do cache
 *   não dependerem do tempo de parede. A entrada do cache é carimbada com o
 *   instante ANTERIOR à consulta (de propósito: nunca vive mais que a TTL
 *   contada a partir do pedido).
 */
function createBongoInternalClient(cfg) {
  const baseUrl = String(cfg.baseUrl || "").replace(/\/+$/, "");
  const serviceToken = cfg.serviceToken || null;
  const timeoutMs = cfg.timeoutMs > 0 ? cfg.timeoutMs : 3000;
  const cacheMs = cfg.cacheMs > 0 ? cfg.cacheMs : 0;
  const fetchImpl = cfg.fetchImpl || nodeFetch;
  const maxEntries = cfg.maxCacheEntries || 10000;
  const clock = typeof cfg.now === "function" ? cfg.now : Date.now;
  const agent = new http.Agent({ keepAlive: false });
  const cache = new Map(); // sha256(token) → { at, data }

  async function postJson(pathname, body, ErrClass) {
    if (!serviceToken) throw new ErrClass("not_configured");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(`${baseUrl}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${serviceToken}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        agent: baseUrl.startsWith("http:") ? agent : undefined,
      });
      // O corpo também fica sob o mesmo prazo (um Bongo que trava no meio da
      // resposta conta como timeout, não como resposta válida).
      let data = null;
      try { data = await r.json(); } catch (e) {
        if (e && e.name === "AbortError") throw e;
        data = null;
      }
      return { status: r.status, data };
    } catch (e) {
      throw new ErrClass(e && e.name === "AbortError" ? "timeout" : "unreachable");
    } finally {
      clearTimeout(timer);
    }
  }

  function sweep(now) {
    if (cache.size < maxEntries) return;
    for (const [k, e] of cache) if (now - e.at >= cacheMs) cache.delete(k);
    if (cache.size >= maxEntries) cache.clear();
  }

  /**
   * Introspecção de uma sessão do portal.
   * @returns {Promise<{active: boolean, reason?: string, user?: object, authorization?: object,
   *                    disabled?: boolean, reauth?: {verified: boolean, purpose?: string}}>}
   * @throws {IdentityUnavailableError}
   */
  async function introspect(token, { reauthToken, reauthPurpose } = {}) {
    const withReauth = typeof reauthToken === "string" && reauthToken.length > 0;
    const key = sha256(token);
    const now = clock();
    if (!withReauth && cacheMs > 0) {
      const hit = cache.get(key);
      if (hit && now - hit.at < cacheMs) return hit.data;
      if (hit) cache.delete(key); // vencido: nunca reaproveitado, nem como reserva
    }
    const body = withReauth ? { token, reauthToken, reauthPurpose } : { token };
    const { status, data } = await postJson("/api/internal/v1/introspect", body, IdentityUnavailableError);
    if (status !== 200) throw new IdentityUnavailableError(`http_${status}`);
    if (!data || typeof data.active !== "boolean") throw new IdentityUnavailableError("malformed");
    if (data.active && (!data.user || typeof data.user.id !== "string" || !data.user.id)) {
      throw new IdentityUnavailableError("malformed");
    }
    if (!withReauth && cacheMs > 0) {
      sweep(now);
      cache.set(key, { at: now, data });
    }
    return data;
  }

  /**
   * Enfileira um e-mail na fila central do Bongo. 202 {id} = aceito na fila
   * (NÃO significa enviado/entregue).
   * @throws {MailEnqueueError}
   */
  async function enqueueMail(message) {
    const { status, data } = await postJson("/api/internal/v1/mail", message, MailEnqueueError);
    if (status !== 202 && status !== 200) throw new MailEnqueueError(`http_${status}`);
    return { id: data && data.id != null ? String(data.id) : null };
  }

  /**
   * Cancela, na fila do Bongo, as mensagens ainda não enviadas dos tokens
   * `refs` (invalidados ou usados aqui). → {cancelled: n}
   * @throws {MailEnqueueError}
   */
  async function cancelMail({ kind, refs }) {
    const { status, data } = await postJson("/api/internal/v1/mail/cancel", { validity: { kind, refs } }, MailEnqueueError);
    if (status !== 200) throw new MailEnqueueError(`http_${status}`);
    return { cancelled: data && Number.isInteger(data.cancelled) ? data.cancelled : 0 };
  }

  /**
   * Estado de UMA conta do portal: {exists, active, qrng}. Sem cache aqui (quem
   * chama decide). @throws {IdentityUnavailableError}
   */
  async function accountStatus(bongoUserId) {
    const { status, data } = await postJson("/api/internal/v1/accounts/status", { ids: [bongoUserId] }, IdentityUnavailableError);
    if (status !== 200) throw new IdentityUnavailableError(`http_${status}`);
    const a = data && data.accounts && data.accounts[bongoUserId];
    if (!a || typeof a.exists !== "boolean" || typeof a.active !== "boolean" || typeof a.qrng !== "boolean") {
      throw new IdentityUnavailableError("malformed");
    }
    return { exists: a.exists, active: a.active, qrng: a.qrng };
  }

  function clearCache() { cache.clear(); }

  return { introspect, enqueueMail, cancelMail, accountStatus, clearCache, configured: Boolean(serviceToken) };
}

module.exports = { createBongoInternalClient, IdentityUnavailableError, MailEnqueueError };
