#!/usr/bin/env python3
"""Autorização POR SERVIÇO do QRNG no nginx do HOST (bongo.dobslit.com) — doc 155 §1.3.

Hoje `/_bongo_auth` (GET /api/auth/me) só prova que a sessão do portal é
válida: conta `pending`, conta sem o serviço `qrng` e (depois do pacote 1)
conta desabilitada passavam pelo gate do QRNG. Este script:

  (1) cria `location = /_bongo_authz_qrng` (internal) → Bongo
      GET /api/auth/authorize/qrng com `Authorization: Bearer $cookie_bongo_session`
      (204 = autorizado, 401 = sem sessão, 403 = sem acesso; qualquer outra
      resposta — Bongo fora — vira 500 no auth_request);
  (2) troca /_bongo_auth → /_bongo_authz_qrng em:
        location /qrng/                          (página: 401 → @bongo_login,
                                                  403 → @qrng_forbidden_page = 302 /cards?acesso=qrng,
                                                  500 → @authz_unavailable_page = 503 HTML no-store)
        location = /qrng/api/stream, = /qrng/api-fpga/stream,
        location ~ ^/qrng/nist/nist/(upload|run)$, location /qrng/nist/
                                                 (APIs: 401 → @qrng_unauth, 403 → @qrng_forbidden,
                                                  500 → @qrng_identity_unavailable; sempre JSON)
  (3) fecha na borda as rotas internas serviço↔serviço:
        location ^~ /api/internal/          (+ variação de caixa)  → 404 JSON
        location ^~ /qrng/v1/internal/v1/   (+ variação de caixa)  → 404 JSON
      (/qrng/v1/internal/docs e /qrng/v1/internal/admin-openapi.json continuam
      indo para a client-api, que tem autenticação própria.)

`/_bongo_auth`, `/edu/` e `location /` NÃO mudam. Todos os outros blocos ficam
byte a byte iguais. As páginas públicas de redefinição de senha do front do
portal (`/redefinir-senha` do Bongo e `/redefinir-senha-api` das contas legadas
da client-api — QRNG_PASSWORD_RESET_URL) vivem sob `location /`, FORA do gate:
o visitante anônimo precisa abrir o link `#token=` do e-mail. O link legado
NUNCA pode apontar para /qrng/ (gate → login/cards e o token se perde).

PRÉ-REQUISITO: bongosite-auth com GET /api/auth/authorize/:service em produção
(o script recusa se 127.0.0.1:<porta>/api/auth/authorize/qrng sem token não
responder 401 — backend ainda não implantado).

Uso na VM (root):   python3 apply_nginx_authz.py [--dry-run]
  --dry-run              só imprime o diff (não grava nada, não recarrega)
  --site PATH            arquivo do site (padrão /etc/nginx/sites-available/bongo.dobslit.com)
  --no-reload            não roda o reload nem o smoke test (testes)
  --reload-cmd CMD       comando de reload (padrão `systemctl reload nginx`)
  --nginx-test-cmd CMD   comando de verificação (padrão `nginx -t`; `{site}` = caminho do site;
                         string vazia = não verificar — só para testes)
  --skip-precheck        não consulta o Bongo (SÓ para testes fora da VM)
  --smoke-base URL       base do smoke test pós-reload (padrão https://bongo.dobslit.com)

Faz backup, roda `nginx -t` e restaura sozinho se a sintaxe falhar. Idempotente:
uma segunda execução não altera nada. A linha de rollback é impressa ANTES do
reload. Códigos de saída: 0 = aplicado e smoke OK (ou nada a alterar);
3 = reload falhou; 4 = smoke pós-reload divergiu (gate possivelmente aberto ou
página pública fechada) — em ambos os casos rode o rollback impresso.
"""
import argparse, datetime, difflib, pathlib, re, shlex, shutil, ssl, subprocess, sys
import urllib.error, urllib.request

SITE_DEFAULT = "/etc/nginx/sites-available/bongo.dobslit.com"

AUTHZ_LOC = "/_bongo_authz_qrng"

NOT_FOUND_JSON = """default_type application/json;
        return 404 '{"error":"NOT_FOUND","message":"Rota nao exposta."}';"""

# Inserido logo depois de `location @bongo_login { ... }`.
AUTHZ_BLOCK = """
    # doc 155 (2026-10-18): autorização POR SERVIÇO do QRNG. /_bongo_auth (acima)
    # só prova sessão válida — inclusive de conta `pending` ou sem o serviço; ele
    # continua servindo /edu/. Este gate pergunta ao Bongo se a conta pode usar
    # o QRNG: 204 = autorizado, 401 = sem sessão, 403 = sem acesso (pending,
    # serviço não concedido, conta desabilitada). Qualquer outra resposta (Bongo
    # fora) vira 500 no auth_request → @authz_unavailable_page (página) e
    # @qrng_identity_unavailable (APIs). Nenhum acesso é concedido sem o Bongo.
    location = /_bongo_authz_qrng {
        internal;
        proxy_pass http://127.0.0.1:%(port)s/api/auth/authorize/qrng;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Authorization "Bearer $cookie_bongo_session";
        proxy_set_header X-Original-URI $request_uri;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_connect_timeout 5s;
        proxy_read_timeout 10s;
    }

    location @qrng_forbidden_page {
        return 302 /cards?acesso=qrng;
    }

    location @authz_unavailable_page {
        default_type "text/html; charset=utf-8";
        add_header Cache-Control "no-store" always;
        add_header Strict-Transport-Security "max-age=31536000" always;
        return 503 '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Serviço indisponível</title></head><body><h1>Serviço temporariamente indisponível</h1><p>Não foi possível verificar seu acesso agora. Tente novamente em instantes.</p><p><a href="/">Voltar ao portal</a></p></body></html>';
    }
"""

# Inserido logo depois de `location @qrng_rate_limited { ... }`.
QRNG_JSON_BLOCK = """    location @qrng_forbidden {
        default_type application/json;
        return 403 '{"error":"FORBIDDEN","message":"Sua conta não tem acesso ao serviço QRNG."}';
    }
    location @qrng_identity_unavailable {
        default_type application/json;
        add_header Cache-Control "no-store" always;
        add_header Strict-Transport-Security "max-age=31536000" always;
        return 503 '{"error":"IDENTITY_UNAVAILABLE","message":"Não foi possível verificar seu acesso agora. Tente novamente em instantes."}';
    }
"""

# Inserido antes de `location /api/`.
API_INTERNAL_BLOCK = """    # doc 155: rotas internas serviço↔serviço do Bongo (/api/internal/v1/*:
    # introspecção, fila de e-mail) nunca saem pela borda, nem com cabeçalho
    # adivinhado. ^~ vence os regex; o ~* pega variações de caixa (o Express
    # roteia sem diferenciar maiúsculas e /api/ repassa o URI original).
    location ^~ /api/internal/ {
        %(nf)s
    }
    location ~* ^/api/internal(/|$) {
        %(nf)s
    }

""" % {"nf": NOT_FOUND_JSON}

# Inserido antes dos comentários de `location /qrng/v1/`.
QRNG_INTERNAL_BLOCK = """    # doc 155: rotas internas da client-api (/v1/internal/v1/*, ex.: validade do
    # token de recuperação consultada pelo worker do Bongo) nunca saem pela borda.
    # /qrng/v1/internal/docs e /qrng/v1/internal/admin-openapi.json NÃO são
    # cobertos (rotas da client-api com autenticação própria).
    location ^~ /qrng/v1/internal/v1/ {
        %(nf)s
    }
    location ~* ^/qrng/v1/internal/v1(/|$) {
        %(nf)s
    }

""" % {"nf": NOT_FOUND_JSON}

OLD_AUTH = "auth_request /_bongo_auth;"
NEW_AUTH = "auth_request /_bongo_authz_qrng;"

API_OLD_EP = "error_page 401 403 = @qrng_unauth;"
API_NEW_EP = ["error_page 401 = @qrng_unauth;",
              "error_page 403 = @qrng_forbidden;",
              "error_page 500 = @qrng_identity_unavailable;"]
PAGE_OLD_EP = "error_page 401 403 = @bongo_login;"
PAGE_NEW_EP = ["# doc 155: 401 → login; 403 (pending / sem o serviço qrng / desabilitada) → cards;",
               "# 500 (Bongo fora do ar) → 503 sem cache. Nunca libera sem o Bongo.",
               "error_page 401 = @bongo_login;",
               "error_page 403 = @qrng_forbidden_page;",
               "error_page 500 = @authz_unavailable_page;"]

# (cabeçalho exato do location, linha antiga de error_page, linhas novas)
GATED = [
    ("= /qrng/api/stream", API_OLD_EP, API_NEW_EP),
    ("= /qrng/api-fpga/stream", API_OLD_EP, API_NEW_EP),
    ("~ ^/qrng/nist/nist/(upload|run)$", API_OLD_EP, API_NEW_EP),
    ("/qrng/nist/", API_OLD_EP, API_NEW_EP),
    ("/qrng/", PAGE_OLD_EP, PAGE_NEW_EP),
]


class PatchError(Exception):
    pass


def find_block(text, spec, with_comments=False):
    """(início, fim) do `location <spec> {…}` por profundidade de chaves.

    `spec` é o texto exato entre `location` e `{`. Com `with_comments`, o início
    engole as linhas de comentário coladas acima do bloco. None se não existir;
    PatchError se existir mais de um."""
    pat = re.compile(r"^[ \t]*location\s+" + re.escape(spec).replace(r"\ ", r"\s+") + r"\s*\{", re.M)
    hits = list(pat.finditer(text))
    if not hits:
        return None
    if len(hits) > 1:
        raise PatchError(f"`location {spec}` aparece {len(hits)} vezes — nada alterado")
    m = hits[0]
    i, depth = m.end(), 1
    while i < len(text) and depth:
        depth += {"{": 1, "}": -1}.get(text[i], 0)
        i += 1
    if depth:
        raise PatchError(f"chaves desbalanceadas em `location {spec}` — nada alterado")
    if text.startswith("\r\n", i):
        i += 2
    elif i < len(text) and text[i] == "\n":
        i += 1
    start = m.start()
    if with_comments:
        while start > 0:
            prev_end = start - 1
            if prev_end > 0 and text[prev_end - 1] == "\r":
                prev_end -= 1
            prev_start = text.rfind("\n", 0, prev_end) + 1
            if text[prev_start:prev_end].strip().startswith("#"):
                start = prev_start
            else:
                break
    return start, i


def require_block(text, spec, with_comments=False):
    r = find_block(text, spec, with_comments)
    if r is None:
        raise PatchError(f"não achei `location {spec} {{` — nada alterado")
    return r


def detect_api_port(text):
    """Porta do Bongo = a do proxy_pass de `location = /_bongo_auth` (mesmo upstream)."""
    a, b = require_block(text, "= /_bongo_auth")
    m = re.search(r"proxy_pass\s+http://127\.0\.0\.1:(\d+)/api/auth/me\s*;", text[a:b])
    if not m:
        raise PatchError("`location = /_bongo_auth` sem `proxy_pass http://127.0.0.1:PORTA/api/auth/me;` — nada alterado")
    return m.group(1)


def _switch_gate(block, old_ep, new_ep, spec, nl):
    """Troca auth_request e error_page DENTRO de um bloco. Idempotente."""
    if NEW_AUTH in block:
        if OLD_AUTH in block or old_ep in block or any(l not in block for l in new_ep):
            raise PatchError(f"`location {spec}` está parcialmente alterado — revise à mão; nada alterado")
        return block
    for needle in (OLD_AUTH, old_ep):
        if block.count(needle) != 1:
            raise PatchError(f"`location {spec}`: esperava exatamente 1 `{needle}` — nada alterado")
    block = block.replace(OLD_AUTH, NEW_AUTH, 1)
    m = re.search(r"^([ \t]*)" + re.escape(old_ep) + r"[ \t]*(\r?\n)", block, re.M)
    if not m:
        raise PatchError(f"`location {spec}`: `{old_ep}` não está sozinho na linha — nada alterado")
    indent = m.group(1)
    repl = "".join(indent + l + nl for l in new_ep)
    return block[:m.start()] + repl + block[m.end():]


def patch(src):
    """Aplica as mudanças do doc 155 §1.3 a `src`. Pura e idempotente."""
    nl = "\r\n" if "\r\n" in src else "\n"
    lf = lambda s: s.replace("\n", nl) if nl != "\n" else s
    port = detect_api_port(src)
    out = src

    # (1) gate por serviço + páginas de erro, depois de @bongo_login
    if find_block(out, "= " + AUTHZ_LOC) is None:
        if find_block(out, "@qrng_forbidden_page") or find_block(out, "@authz_unavailable_page"):
            raise PatchError("named locations da página já existem sem o gate — revise à mão; nada alterado")
        a, b = require_block(out, "@bongo_login")
        out = out[:b] + lf(AUTHZ_BLOCK % {"port": port}) + out[b:]

    # JSON 403/503 das APIs, depois de @qrng_rate_limited
    if find_block(out, "@qrng_forbidden") is None:
        if find_block(out, "@qrng_identity_unavailable"):
            raise PatchError("@qrng_identity_unavailable existe sem @qrng_forbidden — revise à mão; nada alterado")
        a, b = require_block(out, "@qrng_rate_limited")
        out = out[:b] + lf(QRNG_JSON_BLOCK) + out[b:]

    # (2) troca de gate nos 5 blocos do QRNG
    for spec, old_ep, new_ep in GATED:
        a, b = require_block(out, spec)
        out = out[:a] + _switch_gate(out[a:b], old_ep, new_ep, spec, nl) + out[b:]

    # (3) bordas internas
    if find_block(out, "^~ /api/internal/") is None:
        a, b = require_block(out, "/api/", with_comments=True)
        out = out[:a] + lf(API_INTERNAL_BLOCK) + out[a:]
    if find_block(out, "^~ /qrng/v1/internal/v1/") is None:
        a, b = require_block(out, "/qrng/v1/", with_comments=True)
        out = out[:a] + lf(QRNG_INTERNAL_BLOCK) + out[a:]

    check_untouched(src, out)
    return out


# Blocos que o patch nunca pode alterar: /_bongo_auth e /edu/ (gate só de sessão)
# e `location /` (front do portal, onde ficam as páginas PÚBLICAS de redefinição
# /redefinir-senha e /redefinir-senha-api — destino dos links dos e-mails).
UNTOUCHED = ("= /_bongo_auth", "/edu/", "/")


def check_untouched(src, out):
    for spec in UNTOUCHED:
        a0, b0 = require_block(src, spec)
        a1, b1 = require_block(out, spec)
        if src[a0:b0] != out[a1:b1]:
            raise PatchError(f"`location {spec}` mudaria — abortado; nada alterado")


def http_status(url, headers=None, timeout=10):
    req = urllib.request.Request(url, headers=headers or {})
    ctx = ssl.create_default_context()

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ctx))
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)


def precheck(port):
    url = f"http://127.0.0.1:{port}/api/auth/authorize/qrng"
    try:
        code, _ = http_status(url)
    except Exception as e:  # conexão recusada, timeout…
        code = f"erro: {e}"
    print(f"pré-requisito: GET {url} sem token → {code} (esperado 401)")
    return code == 401


def smoke(base):
    print("smoke test pós-reload (sem cookie / cookie inválido; nenhum segredo enviado):")
    checks = [
        ("/qrng/", {}, (302,)),
        ("/qrng/", {"Cookie": "bongo_session=valor-invalido"}, (302,)),
        ("/qrng/api/stream", {}, (401,)),
        ("/qrng/nist/health", {"Cookie": "bongo_session=valor-invalido"}, (401,)),
        ("/api/internal/v1/introspect", {}, (404,)),
        ("/qrng/v1/internal/v1/password-reset/1/status", {}, (404,)),
        ("/qrng/api/health", {}, (200, 503)),
        ("/edu/", {}, (302,)),
        # páginas públicas de redefinição (links dos e-mails): nunca atrás do gate
        ("/redefinir-senha", {}, (200,)),
        ("/redefinir-senha-api", {}, (200,)),
        ("/redefinir-senha-api", {"Cookie": "bongo_session=valor-invalido"}, (200,)),
    ]
    ok = True
    for path, hdrs, want in checks:
        try:
            code, h = http_status(base + path, hdrs)
        except Exception as e:
            code, h = f"erro: {e}", {}
        good = code in want
        ok &= good
        extra = h.get("Location", "") or h.get("Content-Type", "")
        print(f"  {'OK ' if good else 'ERR'} {path} {'(cookie inválido)' if hdrs else ''} → {code} {extra} (esperado {want})")
    print("smoke:", "OK" if ok else "DIVERGÊNCIA")
    return ok


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--site", default=SITE_DEFAULT)
    ap.add_argument("--no-reload", action="store_true")
    ap.add_argument("--reload-cmd", default="systemctl reload nginx")
    ap.add_argument("--nginx-test-cmd", default="nginx -t")
    ap.add_argument("--skip-precheck", action="store_true")
    ap.add_argument("--smoke-base", default="https://bongo.dobslit.com")
    args = ap.parse_args(argv)

    site = pathlib.Path(args.site)
    with open(site, encoding="utf-8", newline="") as f:
        orig = f.read()
    try:
        port = detect_api_port(orig)
        new = patch(orig)
    except PatchError as e:
        sys.exit(str(e))
    print(f"upstream do Bongo: 127.0.0.1:{port}")

    if new == orig:
        print("nada a alterar (já aplicado)")
        return 0
    sys.stdout.write("".join(difflib.unified_diff(orig.splitlines(True), new.splitlines(True), "antes", "depois")))

    if args.skip_precheck:
        print("AVISO: --skip-precheck — pré-requisito do backend NÃO verificado (só para testes)")
    elif not precheck(port):
        sys.exit("o Bongo ainda não tem /api/auth/authorize/:service (faça o deploy do bongosite-auth antes) — nada alterado")

    if args.dry_run:
        print("--dry-run: nada gravado")
        return 0

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = site.with_name(site.name + ".bak-" + ts)
    shutil.copy2(site, bak)
    print(f"backup: {bak}")
    with open(site, "w", encoding="utf-8", newline="") as f:
        f.write(new)
    if args.nginx_test_cmd.strip():
        cmd = [c.replace("{site}", str(site)) for c in shlex.split(args.nginx_test_cmd)]
        t = subprocess.run(cmd, capture_output=True, text=True)
        print((t.stdout + t.stderr).strip())
        if t.returncode != 0:
            shutil.copy2(bak, site)
            sys.exit("nginx -t FALHOU — backup restaurado, nada recarregado")
    else:
        print("AVISO: verificação de sintaxe desligada (--nginx-test-cmd vazio)")
    rollback = f"rollback: cp {bak} {site} && nginx -t && systemctl reload nginx"
    print(rollback)  # antes do reload: fica na tela mesmo se o reload falhar
    if args.no_reload:
        print("--no-reload: nginx NÃO recarregado")
        return 0
    r = subprocess.run(shlex.split(args.reload_cmd), capture_output=True, text=True)
    if r.returncode != 0:
        print((r.stdout + r.stderr).strip())
        print(f"reload FALHOU (exit {r.returncode}) — o arquivo novo está gravado; {rollback}", file=sys.stderr)
        return 3
    print("nginx recarregado")
    if not smoke(args.smoke_base.rstrip("/")):
        print(f"smoke FALHOU — o gate não está no estado esperado; {rollback}", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
