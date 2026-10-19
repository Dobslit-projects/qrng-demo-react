import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { LanguageProvider } from "../../contexts/LanguageContext";
import DeveloperPage from "./DeveloperPage";
import {
  devGetToken, authLogin, portalReauth, identityLink, identityStatus,
  setDevAuthMode, getDevAuthMode, portalToken,
  getAuthHeaders, unbindDevSession,
} from "../../qrngApi";
import { refreshQuota, useQuota } from "../../lib/usage";

// Área do desenvolvedor em modo portal (doc 155, §2.4/§2.5): X-Portal-Session
// em vez de Authorization, status → provisionar/vincular, reauth antes do
// vínculo, 503 com mensagem de nova tentativa, e o modo legado intacto.

const PORTAL_JWT = "portal.jwt.de-teste";
const LEGACY_JWT = "legacy.jwt.de-teste";
const PORTAL_PWD = "senha-do-portal-123";
const LEGACY_PWD = "senha-da-conta-antiga-456";
const REAUTH_TOKEN = "reauth-token-de-uso-unico-0123456789abcdef";

const json = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });

const STATUS_NOT_PROVISIONED = {
  portal: { id: "u-1", email: "ana@example.org", name: "Ana" },
  developer_account: null, can_provision: true, can_link: true,
};
const STATUS_READY = {
  portal: { id: "u-1", email: "ana@example.org", name: "Ana" },
  developer_account: { id: 7, auth_source: "portal", linked_at: "2026-10-18T00:00:00Z", has_token: false },
  can_provision: false, can_link: false,
};

// fetch falso: `routes` = { "METHOD /caminho": (opts, callIndex) => Promise<Response> }
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = vi.fn((url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const path = String(url).split("?")[0];
    const key = `${method} ${path}`;
    calls.push({ key, url: String(url), headers: { ...(opts.headers || {}) }, body: opts.body });
    const h = routes[key];
    if (!h) return json(404, { error: "NOT_FOUND" });
    return h(opts, calls.filter((c) => c.key === key).length);
  });
  return calls;
}

function renderPage() {
  return render(
    <LanguageProvider>
      <DeveloperPage />
    </LanguageProvider>,
  );
}

function clearPortalCookie() {
  document.cookie = "bongo_session=; Path=/; Max-Age=0";
}

let logs;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearPortalCookie();
  unbindDevSession(); // a sessão fixada é do módulo (= da aba): não vaza entre testes
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a.map(String).join(" ")); });
  }
});

afterEach(() => {
  cleanup();
  clearPortalCookie();
  vi.restoreAllMocks();
});

function storageDump() {
  const out = [];
  for (const st of [localStorage, sessionStorage]) {
    for (let i = 0; i < st.length; i++) { const k = st.key(i); out.push(`${k}=${st.getItem(k)}`); }
  }
  return out.join("\n") + "\n" + document.cookie;
}

describe("qrngApi — credencial conforme o modo (nunca as duas)", () => {
  it("modo portal: envia X-Portal-Session (cookie bongo_session) e NÃO envia Authorization, mesmo com qrng_auth_jwt guardado", async () => {
    document.cookie = `bongo_session=${encodeURIComponent(PORTAL_JWT)}; Path=/`;
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    setDevAuthMode("portal");
    const calls = stubFetch({ "GET /qrng/v1/me/token": () => json(200, { has_token: false }) });
    await devGetToken();
    expect(calls[0].headers["X-Portal-Session"]).toBe(PORTAL_JWT);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("modo portal sem cookie: usa localStorage bongo_token (mesma regra de lib/usage.js)", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    expect(portalToken()).toBe(PORTAL_JWT);
    const calls = stubFetch({ "GET /qrng/v1/identity/status": () => json(200, STATUS_NOT_PROVISIONED) });
    await identityStatus();
    expect(calls[0].headers["X-Portal-Session"]).toBe(PORTAL_JWT);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("modo legado: Authorization Bearer <qrng_auth_jwt> e nenhum X-Portal-Session", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    setDevAuthMode("legacy");
    expect(getDevAuthMode()).toBe("legacy");
    const calls = stubFetch({ "GET /qrng/v1/me/token": () => json(200, { has_token: false }) });
    await devGetToken();
    expect(calls[0].headers.Authorization).toBe(`Bearer ${LEGACY_JWT}`);
    expect(calls[0].headers["X-Portal-Session"]).toBeUndefined();
  });

  it("login legado não envia credencial nenhuma", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    const calls = stubFetch({ "POST /qrng/v1/auth/login": () => json(401, { error: "INVALID_CREDENTIALS" }) });
    await authLogin("a@b.c", "x");
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[0].headers["X-Portal-Session"]).toBeUndefined();
  });

  it("portalReauth: POST /api/auth/reauth com Bearer do portal e finalidade link_qrng_developer", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    const calls = stubFetch({ "POST /api/auth/reauth": () => json(200, { reauthToken: REAUTH_TOKEN, expiresAt: "x" }) });
    const r = await portalReauth(PORTAL_PWD);
    expect(r.data.reauthToken).toBe(REAUTH_TOKEN);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${PORTAL_JWT}`);
    expect(JSON.parse(calls[0].body)).toEqual({ currentPassword: PORTAL_PWD, purpose: "link_qrng_developer" });
  });

  it("identityLink: corpo {reauthToken, legacyEmail, legacyPassword} com X-Portal-Session", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    const calls = stubFetch({ "POST /qrng/v1/identity/link": () => json(200, { ok: true }) });
    await identityLink({ reauthToken: REAUTH_TOKEN, legacyEmail: "old@example.org", legacyPassword: LEGACY_PWD });
    expect(JSON.parse(calls[0].body)).toEqual({ reauthToken: REAUTH_TOKEN, legacyEmail: "old@example.org", legacyPassword: LEGACY_PWD });
    expect(calls[0].headers["X-Portal-Session"]).toBe(PORTAL_JWT);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("identityLink: repassa lang (pt|en) para o aviso de vínculo e ignora valores fora da lista", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    const calls = stubFetch({ "POST /qrng/v1/identity/link": () => json(200, { ok: true }) });
    await identityLink({ reauthToken: REAUTH_TOKEN, legacyEmail: "old@example.org", legacyPassword: LEGACY_PWD, lang: "en" });
    await identityLink({ reauthToken: REAUTH_TOKEN, legacyEmail: "old@example.org", legacyPassword: LEGACY_PWD, lang: "fr" });
    expect(JSON.parse(calls[0].body).lang).toBe("en");
    expect("lang" in JSON.parse(calls[1].body)).toBe(false);
  });

  it("corpo não-JSON (página de erro do proxy) vira {ok:false, status} em vez de exceção", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 502, json: async () => { throw new SyntaxError("html"); } }));
    const r = await identityStatus();
    expect(r).toEqual({ ok: false, status: 502, data: {} });
  });
});

describe("DeveloperPage — modo portal (padrão)", () => {
  it("conta de desenvolvedor existente: painel direto, sem segunda senha, chamadas com X-Portal-Session", async () => {
    document.cookie = `bongo_session=${encodeURIComponent(PORTAL_JWT)}; Path=/`;
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT); // resto antigo: não pode ser usado em modo portal
    setDevAuthMode("portal"); // modo já escolhido nesta versão
    const calls = stubFetch({
      "GET /qrng/v1/identity/status": () => json(200, STATUS_READY),
      "GET /qrng/v1/auth/me": () => json(200, { id: 7, email: null, role: "user" }),
      "GET /qrng/v1/me/token": () => json(200, { has_token: false }),
      "GET /qrng/v1/upstream/status": () => json(200, {}),
    });
    renderPage();
    expect(await screen.findByText(/ana@example\.org/)).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.key === "GET /qrng/v1/me/token")).toBe(true));
    expect(screen.queryByLabelText(/Senha/)).not.toBeInTheDocument();
    for (const c of calls) {
      expect(c.headers["X-Portal-Session"]).toBe(PORTAL_JWT);
      expect(c.headers.Authorization).toBeUndefined();
    }
  });

  it("sem conta: cartão de escolha → 'Criar minha área de desenvolvedor' provisiona e abre o painel", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    let provisioned = false;
    const calls = stubFetch({
      "GET /qrng/v1/identity/status": () => json(200, provisioned ? STATUS_READY : STATUS_NOT_PROVISIONED),
      "POST /qrng/v1/identity/provision": () => { provisioned = true; return json(201, { developer_account: STATUS_READY.developer_account }); },
      "GET /qrng/v1/auth/me": () => json(200, { id: 7, email: null, role: "user" }),
      "GET /qrng/v1/me/token": () => json(200, { has_token: false }),
      "GET /qrng/v1/upstream/status": () => json(200, {}),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Criar minha área de desenvolvedor" }));
    expect(await screen.findByRole("button", { name: "Sair" })).toBeInTheDocument();
    const prov = calls.find((c) => c.key === "POST /qrng/v1/identity/provision");
    expect(prov.headers["X-Portal-Session"]).toBe(PORTAL_JWT);
    expect(prov.headers.Authorization).toBeUndefined();
    // o login legado continua alcançável, mas não é o padrão
    expect(calls.filter((c) => c.key === "GET /qrng/v1/identity/status").length).toBe(2);
  });

  it("vincular: reauth no portal e depois /identity/link com o reauthToken; senhas e token nunca são guardados nem logados", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    let linked = false;
    const calls = stubFetch({
      "GET /qrng/v1/identity/status": () => json(200, linked ? STATUS_READY : STATUS_NOT_PROVISIONED),
      "POST /api/auth/reauth": () => json(200, { reauthToken: REAUTH_TOKEN, expiresAt: "2026-10-18T00:05:00Z" }),
      "POST /qrng/v1/identity/link": () => { linked = true; return json(200, { developer_account: { ...STATUS_READY.developer_account, auth_source: "legacy" } }); },
      "GET /qrng/v1/auth/me": () => json(200, { id: 3, email: "old@example.org", role: "user" }),
      "GET /qrng/v1/me/token": () => json(200, { has_token: true, token_prefix: "qrng_abc", requests_today: 0, quota_daily: 100 }),
      "GET /qrng/v1/upstream/status": () => json(200, {}),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Já tenho uma conta antiga da API — vincular" }));
    fireEvent.change(screen.getByLabelText("Senha do portal"), { target: { value: PORTAL_PWD } });
    fireEvent.change(screen.getByLabelText("E-mail da conta antiga da API"), { target: { value: "old@example.org" } });
    fireEvent.change(screen.getByLabelText("Senha da conta antiga da API"), { target: { value: LEGACY_PWD } });
    fireEvent.click(screen.getByRole("button", { name: "Vincular contas" }));
    expect(await screen.findByRole("button", { name: "Sair" })).toBeInTheDocument();

    const keys = calls.map((c) => c.key);
    const iRe = keys.indexOf("POST /api/auth/reauth");
    const iLink = keys.indexOf("POST /qrng/v1/identity/link");
    expect(iRe).toBeGreaterThanOrEqual(0);
    expect(iLink).toBeGreaterThan(iRe);
    expect(JSON.parse(calls[iRe].body)).toEqual({ currentPassword: PORTAL_PWD, purpose: "link_qrng_developer" });
    expect(calls[iRe].headers.Authorization).toBe(`Bearer ${PORTAL_JWT}`);
    expect(JSON.parse(calls[iLink].body)).toEqual({ reauthToken: REAUTH_TOKEN, legacyEmail: "old@example.org", legacyPassword: LEGACY_PWD, lang: "pt" });
    expect(calls[iLink].headers["X-Portal-Session"]).toBe(PORTAL_JWT);
    expect(calls[iLink].headers.Authorization).toBeUndefined();

    const dump = storageDump();
    for (const secret of [PORTAL_PWD, LEGACY_PWD, REAUTH_TOKEN]) {
      expect(dump).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
    }
    // o vínculo não cria sessão legada no navegador
    expect(localStorage.getItem("qrng_auth_jwt")).toBeNull();
  });

  it("vincular: 409 ACCOUNT_ALREADY_LINKED mostra texto explícito e apaga as senhas dos campos", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    stubFetch({
      "GET /qrng/v1/identity/status": () => json(200, STATUS_NOT_PROVISIONED),
      "POST /api/auth/reauth": () => json(200, { reauthToken: REAUTH_TOKEN, expiresAt: "x" }),
      "POST /qrng/v1/identity/link": () => json(409, { error: "ACCOUNT_ALREADY_LINKED", message: "x" }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Já tenho uma conta antiga da API — vincular" }));
    fireEvent.change(screen.getByLabelText("Senha do portal"), { target: { value: PORTAL_PWD } });
    fireEvent.change(screen.getByLabelText("E-mail da conta antiga da API"), { target: { value: "old@example.org" } });
    fireEvent.change(screen.getByLabelText("Senha da conta antiga da API"), { target: { value: LEGACY_PWD } });
    fireEvent.click(screen.getByRole("button", { name: "Vincular contas" }));
    expect(await screen.findByText("Esta conta antiga da API já está vinculada a outra conta do portal.")).toBeInTheDocument();
    expect(screen.getByLabelText("Senha do portal").value).toBe("");
    expect(screen.getByLabelText("Senha da conta antiga da API").value).toBe("");
  });

  it("vincular: senha do portal errada (403 CURRENT_PASSWORD_INVALID do Bongo) não chama /identity/link", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    const calls = stubFetch({
      "GET /qrng/v1/identity/status": () => json(200, STATUS_NOT_PROVISIONED),
      "POST /api/auth/reauth": () => json(403, { error: "Senha atual incorreta.", code: "CURRENT_PASSWORD_INVALID" }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Já tenho uma conta antiga da API — vincular" }));
    fireEvent.change(screen.getByLabelText("Senha do portal"), { target: { value: "errada" } });
    fireEvent.change(screen.getByLabelText("E-mail da conta antiga da API"), { target: { value: "old@example.org" } });
    fireEvent.change(screen.getByLabelText("Senha da conta antiga da API"), { target: { value: LEGACY_PWD } });
    fireEvent.click(screen.getByRole("button", { name: "Vincular contas" }));
    expect(await screen.findByText("Senha do portal incorreta.")).toBeInTheDocument();
    expect(calls.some((c) => c.key === "POST /qrng/v1/identity/link")).toBe(false);
  });

  it("503 IDENTITY_UNAVAILABLE: mostra a mensagem de nova tentativa e 'Tentar novamente' recupera", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    stubFetch({
      "GET /qrng/v1/identity/status": (_o, n) => (n === 1
        ? json(503, { error: "IDENTITY_UNAVAILABLE", message: "x" })
        : json(200, STATUS_NOT_PROVISIONED)),
    });
    renderPage();
    expect(await screen.findByText(/serviço de identidade do portal está indisponível/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByRole("button", { name: "Criar minha área de desenvolvedor" })).toBeInTheDocument();
  });

  it("403 QRNG_ACCESS_DENIED: explica a falta de acesso e não oferece criar conta", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    stubFetch({ "GET /qrng/v1/identity/status": () => json(403, { error: "QRNG_ACCESS_DENIED", message: "x" }) });
    renderPage();
    expect(await screen.findByText(/não tem acesso ao QRNG/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Criar minha área de desenvolvedor" })).not.toBeInTheDocument();
  });

  it("provisionar com 409 PORTAL_ALREADY_LINKED: texto explícito", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    stubFetch({
      "GET /qrng/v1/identity/status": () => json(200, STATUS_NOT_PROVISIONED),
      "POST /qrng/v1/identity/provision": () => json(409, { error: "PORTAL_ALREADY_LINKED", message: "x" }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Criar minha área de desenvolvedor" }));
    expect(await screen.findByText(/já tem uma área de desenvolvedor/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recarregar" })).toBeInTheDocument();
  });

  it("sair em modo portal apaga só as chaves do QRNG — a sessão do portal fica", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    localStorage.setItem("qrng_api_token", "qrng_tok_completo");
    stubFetch({
      "GET /qrng/v1/identity/status": () => json(200, STATUS_READY),
      "GET /qrng/v1/auth/me": () => json(200, { id: 7, email: null, role: "user" }),
      "GET /qrng/v1/me/token": () => json(200, { has_token: false }),
      "GET /qrng/v1/upstream/status": () => json(200, {}),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Sair" }));
    expect(await screen.findByText(/Sua sessão do portal continua ativa/)).toBeInTheDocument();
    expect(localStorage.getItem("bongo_token")).toBe(PORTAL_JWT);
    expect(localStorage.getItem("qrng_api_token")).toBeNull();
  });

  it("sem sessão do portal: pede para entrar no portal e mantém o link da conta antiga e do 'esqueci a senha'", async () => {
    const calls = stubFetch({});
    renderPage();
    expect(await screen.findByText("Entre no portal para acessar a área do desenvolvedor.")).toBeInTheDocument();
    expect(calls.length).toBe(0);
    expect(screen.getByRole("button", { name: "Entrar com conta antiga da API (e-mail e senha)" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Esqueci a senha da conta antiga" })).toHaveAttribute("href", "/esqueci-minha-senha?conta=api");
  });
});

describe("atualização a partir da versão anterior (sessão legada já aberta no navegador)", () => {
  it("sem dica gravada + qrng_auth_jwt: retoma a conta antiga UMA vez (grava 'legacy'); chip de cota volta a mostrar o token", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    expect(localStorage.getItem("qrng_dev_auth_mode")).toBeNull();
    expect(getDevAuthMode()).toBe("legacy");
    expect(localStorage.getItem("qrng_dev_auth_mode")).toBe("legacy");
    const calls = stubFetch({
      "GET /qrng/v1/public/quota": () => json(200, { limit: 10, used: 1 }),
      "GET /qrng/v1/me/usage": () => json(200, { has_token: true, token_name: "Token principal", requests_today: 3 }),
    });
    render(<QuotaProbe />);
    await waitFor(() => expect(screen.getByTestId("quota-token").textContent).toBe("token:Token principal"));
    const usage = calls.find((c) => c.key === "GET /qrng/v1/me/usage");
    expect(usage.headers.Authorization).toBe(`Bearer ${LEGACY_JWT}`);
    expect(usage.headers["X-Portal-Session"]).toBeUndefined();
  });

  it("sem dica gravada + qrng_auth_jwt: a área do desenvolvedor reabre o painel da conta antiga", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    const calls = stubFetch({
      "GET /qrng/v1/auth/me": () => json(200, { id: 3, email: "old@example.org", role: "user" }),
      "GET /qrng/v1/me/token": () => json(200, { has_token: false }),
      "GET /qrng/v1/upstream/status": () => json(200, {}),
    });
    renderPage();
    expect(await screen.findByText(/old@example\.org/)).toBeInTheDocument();
    expect(calls.some((c) => c.key === "GET /qrng/v1/identity/status")).toBe(false);
  });

  it("JWT antigo inválido: volta ao portal e grava 'portal' (o JWT não é reenviado depois)", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    stubFetch({
      "GET /qrng/v1/auth/me": () => json(401, { error: "SESSION_EXPIRED", message: "x" }),
      "GET /qrng/v1/identity/status": () => json(200, STATUS_NOT_PROVISIONED),
    });
    renderPage();
    await waitFor(() => expect(getDevAuthMode()).toBe("portal"));
    expect(localStorage.getItem("qrng_dev_auth_mode")).toBe("portal");
    expect(getAuthHeaders().Authorization).toBeUndefined();
  });

  it("sem dica e sem JWT (navegador novo): modo portal", () => {
    expect(getDevAuthMode()).toBe("portal");
  });
});

describe("DeveloperPage — conta antiga da API (caminho secundário)", () => {
  it("sessão legada guardada: usa Authorization Bearer qrng_auth_jwt e nunca X-Portal-Session", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    setDevAuthMode("legacy");
    const calls = stubFetch({
      "GET /qrng/v1/auth/me": () => json(200, { id: 3, email: "old@example.org", role: "user" }),
      "GET /qrng/v1/me/token": () => json(200, { has_token: false }),
      "GET /qrng/v1/upstream/status": () => json(200, {}),
    });
    renderPage();
    expect(await screen.findByText(/old@example\.org/)).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.key === "GET /qrng/v1/me/token")).toBe(true));
    expect(calls.some((c) => c.key === "GET /qrng/v1/identity/status")).toBe(false);
    for (const c of calls) {
      expect(c.headers.Authorization).toBe(`Bearer ${LEGACY_JWT}`);
      expect(c.headers["X-Portal-Session"]).toBeUndefined();
    }
  });

  it("link 'Entrar com conta antiga' → login legado grava o JWT e as chamadas seguintes usam Authorization", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    const calls = stubFetch({
      "GET /qrng/v1/identity/status": () => json(200, STATUS_NOT_PROVISIONED),
      "POST /qrng/v1/auth/login": () => json(200, { token: LEGACY_JWT, email: "old@example.org", role: "user" }),
      "GET /qrng/v1/me/token": () => json(200, { has_token: false }),
      "GET /qrng/v1/upstream/status": () => json(200, {}),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Entrar com conta antiga da API (e-mail e senha)" }));
    expect(screen.getByRole("link", { name: "Esqueci a senha da conta antiga" })).toHaveAttribute("href", "/esqueci-minha-senha?conta=api");
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "old@example.org" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: LEGACY_PWD } });
    fireEvent.click(screen.getAllByRole("button", { name: "Entrar" }).at(-1));
    expect(await screen.findByRole("button", { name: "Sair" })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.key === "GET /qrng/v1/me/token")).toBe(true));
    expect(localStorage.getItem("qrng_auth_jwt")).toBe(LEGACY_JWT);
    expect(getDevAuthMode()).toBe("legacy");
    const tok = calls.find((c) => c.key === "GET /qrng/v1/me/token");
    expect(tok.headers.Authorization).toBe(`Bearer ${LEGACY_JWT}`);
    expect(tok.headers["X-Portal-Session"]).toBeUndefined();
    expect(storageDump()).not.toContain(LEGACY_PWD);
  });

  it("AuthPage traduz os códigos MAIÚSCULOS do servidor (INVALID_CREDENTIALS)", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    stubFetch({
      "GET /qrng/v1/identity/status": () => json(200, STATUS_NOT_PROVISIONED),
      "POST /qrng/v1/auth/login": () => json(401, { error: "INVALID_CREDENTIALS", message: "texto do servidor" }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Entrar com conta antiga da API (e-mail e senha)" }));
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "old@example.org" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "x" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Entrar" }).at(-1));
    expect(await screen.findByText("E-mail ou senha incorretos.")).toBeInTheDocument();
    expect(screen.queryByText("texto do servidor")).not.toBeInTheDocument();
  });

  it("AuthPage traduz EMAIL_TAKEN e INVALID_EMAIL no cadastro legado", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    let n = 0;
    stubFetch({
      "GET /qrng/v1/identity/status": () => json(200, STATUS_NOT_PROVISIONED),
      "POST /qrng/v1/auth/register": () => (++n === 1
        ? json(409, { error: "EMAIL_TAKEN", message: "x" })
        : json(400, { error: "INVALID_EMAIL", message: "x" })),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Entrar com conta antiga da API (e-mail e senha)" }));
    fireEvent.click(screen.getByRole("button", { name: "Criar conta" }));
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "old@example.org" } });
    fireEvent.change(screen.getByLabelText(/^Senha/), { target: { value: LEGACY_PWD } });
    fireEvent.change(screen.getByLabelText("Confirmar senha"), { target: { value: LEGACY_PWD } });
    fireEvent.click(screen.getByRole("checkbox"));
    const submit = () => fireEvent.click(screen.getAllByRole("button", { name: "Criar conta" }).at(-1));
    submit();
    expect(await screen.findByText("Este e-mail já está cadastrado.")).toBeInTheDocument();
    submit();
    expect(await screen.findByText("E-mail inválido.")).toBeInTheDocument();
  });
});

// ── Revisão adversarial: uma identidade por aba ─────────────────────────────────

const STATUS_READY_WITH_TOKEN = {
  ...STATUS_READY,
  developer_account: { ...STATUS_READY.developer_account, has_token: true },
};
const TOKEN_ACTIVE = { has_token: true, status: "active", token_prefix: "qrng_abc", requests_today: 0, quota_daily: 100 };

function QuotaProbe() {
  const q = useQuota();
  return <span data-testid="quota-token">{q.loading ? "loading" : q.token ? `token:${q.token.token_name}` : "anon"}</span>;
}

describe("getAuthHeaders / chip de cota — nunca o JWT legado em modo portal", () => {
  it("modo portal gravado com qrng_auth_jwt que sobrou: X-Portal-Session e nenhum Authorization", () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    setDevAuthMode("portal");
    expect(getDevAuthMode()).toBe("portal");
    const h = getAuthHeaders();
    expect(h.Authorization).toBeUndefined();
    expect(h["X-Portal-Session"]).toBe(PORTAL_JWT);
    expect(JSON.stringify(h)).not.toContain(LEGACY_JWT);
  });

  it("modo legado: Authorization Bearer <qrng_auth_jwt> e nenhum X-Portal-Session", () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    setDevAuthMode("legacy");
    expect(getAuthHeaders()).toEqual({ Authorization: `Bearer ${LEGACY_JWT}` });
  });

  it("chip de cota em modo portal: /me/usage com X-Portal-Session (sem o JWT legado); 404 DEVELOPER_ACCOUNT_NOT_PROVISIONED → só a cota pública", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    setDevAuthMode("portal");
    const calls = stubFetch({
      "GET /qrng/v1/public/quota": () => json(200, { limit: 10, used: 1 }),
      "GET /qrng/v1/me/usage": () => json(404, { error: "DEVELOPER_ACCOUNT_NOT_PROVISIONED", message: "x" }),
    });
    render(<QuotaProbe />);
    await waitFor(() => expect(screen.getByTestId("quota-token").textContent).toBe("anon"));
    const usage = calls.filter((c) => c.key === "GET /qrng/v1/me/usage");
    expect(usage.length).toBeGreaterThanOrEqual(1);
    for (const c of usage) {
      expect(c.headers.Authorization).toBeUndefined();
      expect(c.headers["X-Portal-Session"]).toBe(PORTAL_JWT);
    }
    expect(JSON.stringify(calls)).not.toContain(LEGACY_JWT);
  });

  it("chip de cota sem sessão nenhuma (portal sem cookie, só JWT legado em modo portal): não consulta /me/usage", async () => {
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    setDevAuthMode("portal");
    const calls = stubFetch({ "GET /qrng/v1/public/quota": () => json(200, { limit: 10, used: 1 }) });
    await refreshQuota();
    expect(calls.map((c) => c.key)).toEqual(["GET /qrng/v1/public/quota"]);
    expect(JSON.stringify(calls)).not.toContain(LEGACY_JWT);
  });
});

describe("DeveloperPage — a credencial é a da sessão mostrada nesta aba", () => {
  it("outra aba entra numa conta legada (dica vira 'legacy'): 'Revogar' aqui continua na conta do portal mostrada", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = stubFetch({
      "GET /qrng/v1/identity/status": () => json(200, STATUS_READY_WITH_TOKEN),
      "GET /qrng/v1/auth/me": () => json(200, { id: 7, email: null, role: "user" }),
      "GET /qrng/v1/me/token": () => json(200, TOKEN_ACTIVE),
      "GET /qrng/v1/upstream/status": () => json(200, {}),
      "POST /qrng/v1/me/token/revoke": () => json(200, { message: "ok" }),
    });
    renderPage();
    const revoke = await screen.findByRole("button", { name: "Revogar" });
    // outra aba: login legado grava o JWT e a dica de modo (o mesmo localStorage)
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    setDevAuthMode("legacy");
    fireEvent.click(revoke);
    await waitFor(() => expect(calls.some((c) => c.key === "POST /qrng/v1/me/token/revoke")).toBe(true));
    const r = calls.find((c) => c.key === "POST /qrng/v1/me/token/revoke");
    expect(r.headers["X-Portal-Session"]).toBe(PORTAL_JWT);
    expect(r.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(calls)).not.toContain(LEGACY_JWT);
  });

  it("outra aba troca o JWT legado (outra conta antiga): 'Revogar' NÃO sai e a página volta à entrada com a conta nova", async () => {
    const OTHER_JWT = "legacy.jwt.de-outra-conta";
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    setDevAuthMode("legacy");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = stubFetch({
      "GET /qrng/v1/auth/me": (opts) => json(200, opts.headers.Authorization === `Bearer ${OTHER_JWT}`
        ? { id: 9, email: "outra@example.org", role: "user" }
        : { id: 3, email: "old@example.org", role: "user" }),
      "GET /qrng/v1/me/token": () => json(200, TOKEN_ACTIVE),
      "GET /qrng/v1/upstream/status": () => json(200, {}),
      "POST /qrng/v1/me/token/revoke": () => json(200, { message: "ok" }),
    });
    renderPage();
    expect(await screen.findByText(/old@example\.org/)).toBeInTheDocument();
    const revoke = await screen.findByRole("button", { name: "Revogar" });
    localStorage.setItem("qrng_auth_jwt", OTHER_JWT); // outra aba
    fireEvent.click(revoke);
    expect(await screen.findByText(/outra@example\.org/)).toBeInTheDocument();
    expect(calls.some((c) => c.key === "POST /qrng/v1/me/token/revoke")).toBe(false);
    // a sessão nova da outra aba não é apagada
    expect(localStorage.getItem("qrng_auth_jwt")).toBe(OTHER_JWT);
  });

  it("outra aba troca a sessão do portal (outra conta): 'Rotacionar' NÃO sai com a sessão nova; a identidade é verificada de novo", async () => {
    const OTHER_PORTAL = "portal.jwt.de-outra-pessoa";
    localStorage.setItem("bongo_token", PORTAL_JWT);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = stubFetch({
      "GET /qrng/v1/identity/status": (opts) => json(200, opts.headers["X-Portal-Session"] === OTHER_PORTAL
        ? STATUS_NOT_PROVISIONED
        : STATUS_READY_WITH_TOKEN),
      "GET /qrng/v1/auth/me": () => json(200, { id: 7, email: null, role: "user" }),
      "GET /qrng/v1/me/token": () => json(200, TOKEN_ACTIVE),
      "GET /qrng/v1/upstream/status": () => json(200, {}),
      "POST /qrng/v1/me/token/rotate": () => json(200, { token: "qrng_novo" }),
    });
    renderPage();
    const rotate = await screen.findByRole("button", { name: "Regenerar" });
    localStorage.setItem("bongo_token", OTHER_PORTAL); // outra aba
    fireEvent.click(rotate);
    expect(await screen.findByRole("button", { name: "Criar minha área de desenvolvedor" })).toBeInTheDocument();
    expect(calls.some((c) => c.key === "POST /qrng/v1/me/token/rotate")).toBe(false);
    const st = calls.filter((c) => c.key === "GET /qrng/v1/identity/status");
    expect(st.at(-1).headers["X-Portal-Session"]).toBe(OTHER_PORTAL);
  });

  it("evento 'storage' de outra aba com a credencial trocada também reinicia a página", async () => {
    const OTHER_JWT = "legacy.jwt.de-outra-conta";
    localStorage.setItem("qrng_auth_jwt", LEGACY_JWT);
    setDevAuthMode("legacy");
    stubFetch({
      "GET /qrng/v1/auth/me": (opts) => json(200, opts.headers.Authorization === `Bearer ${OTHER_JWT}`
        ? { id: 9, email: "outra@example.org", role: "user" }
        : { id: 3, email: "old@example.org", role: "user" }),
      "GET /qrng/v1/me/token": () => json(200, { has_token: false }),
      "GET /qrng/v1/upstream/status": () => json(200, {}),
    });
    renderPage();
    expect(await screen.findByText(/old@example\.org/)).toBeInTheDocument();
    localStorage.setItem("qrng_auth_jwt", OTHER_JWT);
    window.dispatchEvent(new StorageEvent("storage", { key: "qrng_auth_jwt" }));
    expect(await screen.findByText(/outra@example\.org/)).toBeInTheDocument();
  });

  it("'Sair' em modo portal: recarregar a aba NÃO reabre o painel até 'Continuar com minha conta do portal'", async () => {
    localStorage.setItem("bongo_token", PORTAL_JWT);
    const calls = stubFetch({
      "GET /qrng/v1/identity/status": () => json(200, STATUS_READY),
      "GET /qrng/v1/auth/me": () => json(200, { id: 7, email: null, role: "user" }),
      "GET /qrng/v1/me/token": () => json(200, { has_token: false }),
      "GET /qrng/v1/upstream/status": () => json(200, {}),
      "GET /qrng/v1/public/quota": () => json(200, { limit: 10, used: 1 }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Sair" }));
    expect(await screen.findByText(/Sua sessão do portal continua ativa/)).toBeInTheDocument();
    // a saída desta aba também cala a credencial do chip de cota
    expect(getAuthHeaders()).toEqual({});
    cleanup();
    unbindDevSession(); // "recarregar": módulo novo
    const before = calls.length;
    renderPage();
    expect(await screen.findByText(/Sua sessão do portal continua ativa/)).toBeInTheDocument();
    expect(calls.length).toBe(before); // nenhuma chamada com a sessão do portal
    fireEvent.click(screen.getByRole("button", { name: "Continuar com minha conta do portal" }));
    expect(await screen.findByRole("button", { name: "Sair" })).toBeInTheDocument();
    expect(sessionStorage.getItem("qrng_dev_portal_signed_out")).toBeNull();
  });
});
