"use strict";

/**
 * Bongo de mentira para os testes da client-api (fora de test/ de propósito:
 * `node --test test/` executaria qualquer .js lá dentro como arquivo de teste).
 *
 * Implementa os contratos INTERNOS do doc 155:
 *   POST /api/internal/v1/introspect  {token, reauthToken?, reauthPurpose?}
 *   POST /api/internal/v1/mail        {template, to, locale, secret, secretExpiresAt, idempotencyKey, validity}
 *   POST /api/internal/v1/mail/cancel {validity:{kind, refs}}
 *   POST /api/internal/v1/accounts/status {ids} — estado vem de `state.accounts`
 *        (id → {exists, active, qrng}); sem entrada, deriva das sessões criadas
 * ambos só com `Authorization: Bearer <serviceToken>` (sem ele → 404, como se
 * a rota não existisse).
 *
 * Comportamentos alternáveis em `state`:
 *   mode:     ok | down (derruba o socket) | error500 | slow (responde depois de slowMs) | malformed
 *   mailMode: ok | down | error500
 */

const http = require("node:http");
const crypto = require("node:crypto");

function createFakeBongo({ serviceToken }) {
  const state = {
    mode: "ok",
    slowMs: 1500,
    mailMode: "ok",
    sessions: new Map(), // token → { user, active, qrng }
    reauth: new Map(),   // reauthToken → { userId, purpose, used }
    mails: [],
    cancels: [], // {kind, refs}
    accounts: new Map(), // bongo user id → {exists, active, qrng}
    accountsMode: "ok", // ok | down
    calls: { introspect: 0, mail: 0, cancel: 0, accounts: 0, unauthorized: 0 },
  };

  function send(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  function introspect(body) {
    const s = state.sessions.get(body.token);
    if (!s || !s.active) return { active: false, reason: s ? "revoked" : "invalid_token" };
    const out = {
      active: true,
      user: { ...s.user },
      authorization: { qrng: s.qrng },
      token_version: 1,
      disabled: false,
    };
    if (typeof body.reauthToken === "string") {
      const r = state.reauth.get(body.reauthToken);
      // uso único, mesma pessoa, mesma finalidade — consumido aqui mesmo se a finalidade não bater
      const verified = Boolean(r && !r.used && r.userId === s.user.id && r.purpose === body.reauthPurpose);
      if (r && r.userId === s.user.id) r.used = true;
      out.reauth = { verified, purpose: body.reauthPurpose };
    }
    return out;
  }

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${serviceToken}`) {
        state.calls.unauthorized++;
        return send(res, 404, { error: "NOT_FOUND" });
      }
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "INVALID_JSON" }); }

      if (req.method === "POST" && req.url === "/api/internal/v1/introspect") {
        state.calls.introspect++;
        if (state.mode === "down") return req.socket.destroy();
        if (state.mode === "error500") return send(res, 500, { error: "INTERNAL_ERROR" });
        if (state.mode === "malformed") return send(res, 200, { ok: "talvez" });
        const result = introspect(body);
        if (state.mode === "slow") { setTimeout(() => send(res, 200, result), state.slowMs); return; }
        return send(res, 200, result);
      }
      if (req.method === "POST" && req.url === "/api/internal/v1/mail") {
        state.calls.mail++;
        if (state.mailMode === "down") return req.socket.destroy();
        if (state.mailMode === "error500") return send(res, 500, { error: "INTERNAL_ERROR" });
        const id = crypto.randomUUID();
        state.mails.push({ id, ...body });
        return send(res, 202, { id });
      }
      if (req.method === "POST" && req.url === "/api/internal/v1/accounts/status") {
        state.calls.accounts++;
        if (state.accountsMode === "down") return req.socket.destroy();
        const accounts = {};
        for (const id of body.ids || []) {
          let a = state.accounts.get(id);
          if (!a) {
            const s = [...state.sessions.values()].find((x) => x.user.id === id);
            a = s ? { exists: true, active: true, qrng: s.qrng } : { exists: false, active: false, qrng: false };
          }
          accounts[id] = a;
        }
        return send(res, 200, { accounts });
      }
      if (req.method === "POST" && req.url === "/api/internal/v1/mail/cancel") {
        state.calls.cancel++;
        if (state.mailMode === "down") return req.socket.destroy();
        if (state.mailMode === "error500") return send(res, 500, { error: "INTERNAL_ERROR" });
        const v = body.validity || {};
        state.cancels.push({ kind: v.kind, refs: v.refs });
        return send(res, 200, { cancelled: Array.isArray(v.refs) ? v.refs.length : 0 });
      }
      return send(res, 404, { error: "NOT_FOUND" });
    });
  });

  return {
    state,
    async listen() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close() { return new Promise((r) => server.close(r)); },
    /** Cria uma sessão de portal; devolve o token opaco (o Bongo real usa JWT). */
    addSession(user, { qrng = true } = {}) {
      const token = `portal-session-${crypto.randomBytes(12).toString("hex")}`;
      state.sessions.set(token, {
        user: { role: "user", services: qrng ? ["qrng"] : [], name: "Pessoa Teste", ...user },
        active: true,
        qrng,
      });
      return token;
    },
    revoke(token) { const s = state.sessions.get(token); if (s) s.active = false; },
    /** Reautenticação recente (o que POST /api/auth/reauth do Bongo emitiria). */
    addReauth(userId, purpose = "link_qrng_developer") {
      const t = `reauth-${crypto.randomBytes(16).toString("hex")}`;
      state.reauth.set(t, { userId, purpose, used: false });
      return t;
    },
    /** Estado da conta do portal visto por /accounts/status. */
    setAccount(id, status) { state.accounts.set(id, status); },
    reset() {
      state.mode = "ok"; state.mailMode = "ok"; state.accountsMode = "ok";
    },
  };
}

/**
 * Captura tudo o que o processo escreve no console (para provar que nenhum
 * segredo vai parar em log). Repassa a saída original.
 */
function captureConsole() {
  const lines = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : (a && a.stack) || JSON.stringify(a))).join(" "));
      orig(...args);
    };
  }
  return lines;
}

/** Despejo textual de TODAS as tabelas do banco (para varrer segredos). */
function dumpDatabase(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  return tables.map((t) => `${t}: ${JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())}`).join("\n");
}

module.exports = { createFakeBongo, captureConsole, dumpDatabase };
