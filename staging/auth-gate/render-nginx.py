#!/usr/bin/env python3
"""Gera a config do nginx do ambiente de teste A PARTIR da de produção corrigida.

  nginx/bongo.dobslit.com.prod.conf   cópia da produção (entrada, só leitura)
        │  apply_nginx_authz.patch()  (o MESMO código que vai para a VM: nginx/apply_nginx_authz.py)
        ▼
  nginx/rendered/bongo.dobslit.com.patched.conf   = o que a VM terá depois do script
        │  adaptação mínima e verificada (abaixo)
        ▼
  nginx/rendered/default.conf  +  nginx/rendered/kuapoa-limits.conf

Adaptações (cada uma conferida; qualquer surpresa aborta):
  - só o primeiro `server { }` (o de :80 do Certbot é só redirecionamento);
  - linhas `# managed by Certbot` (listen 443/ssl_*) → `listen 80;`;
  - logs → /dev/stdout e /dev/stderr;
  - 127.0.0.1:PORTA → nomes dos serviços do compose (tabela UPSTREAMS);
  - zonas de limite: a de jobs do NIST passa de 2r/m para 6000r/m (a matriz
    dispara ~15 POSTs seguidos; limit_req roda ANTES do auth_request e
    mascararia 401/403 com 429). Todas as diretivas `location` ficam idênticas.

Uso:  python3 render-nginx.py [--check]   (--check: falha se o renderizado mudou)
"""
import importlib.util, pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent
NG = HERE / "nginx"
OUT = NG / "rendered"

UPSTREAMS = {
    "127.0.0.1:3101": "bongosite-auth:3002",     # bongosite-auth
    "127.0.0.1:3010": "qrng-client-api:3010",    # qrng-client-api
    "127.0.0.1:18001": "fixture-upstream:18091", # broker (stream)
    "127.0.0.1:18002": "stubs:18002",            # NIST
    "127.0.0.1:3001": "stubs:3001",              # SPA do QRNG
    "127.0.0.1:8081": "stubs:8081",              # front do portal
    "127.0.0.1:5000": "stubs:8099",              # dobflight
    "127.0.0.1:8100": "stubs:8099",              # qml api
    "127.0.0.1:8090": "stubs:8099",              # faro
}
NIST_RATE_PROD, NIST_RATE_TEST = "rate=2r/m;", "rate=6000r/m;"


def load_patcher():
    spec = importlib.util.spec_from_file_location("apply_nginx_authz", NG / "apply_nginx_authz.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def first_server(text):
    m = re.search(r"^server\s*\{", text, re.M)
    if not m:
        sys.exit("render: `server {` não encontrado")
    i, depth = m.end(), 1
    while depth:
        depth += {"{": 1, "}": -1}.get(text[i], 0)
        i += 1
    return text[m.start():i] + "\n"


def render_site(patched):
    s = first_server(patched)
    lines, certbot = [], 0
    for line in s.split("\n"):
        if "# managed by Certbot" in line:
            certbot += 1
            continue
        lines.append(line)
    if certbot != 6:
        sys.exit(f"render: esperava 6 linhas do Certbot no server 443, achei {certbot}")
    s = "\n".join(lines)
    s = s.replace("server {\n", "server {\n    listen 80;  # teste: TLS termina fora (render-nginx.py)\n", 1)
    s, n1 = re.subn(r"^(\s*)access_log\s+\S+;", r"\1access_log /dev/stdout;", s, flags=re.M)
    s, n2 = re.subn(r"^(\s*)error_log\s+\S+;", r"\1error_log  /dev/stderr warn;", s, flags=re.M)
    if (n1, n2) != (1, 1):
        sys.exit("render: access_log/error_log inesperados")
    code = lambda l: not l.lstrip().startswith("#")  # comentários ficam como na VM
    out = s.split("\n")
    for src, dst in UPSTREAMS.items():
        pat = re.compile(re.escape(src) + r"(?=[/;])")
        hits = 0
        for i, l in enumerate(out):
            if code(l):
                out[i], n = pat.subn(dst, l)
                hits += n
        if hits == 0:
            sys.exit(f"render: upstream {src} não aparece na config — a tabela UPSTREAMS está desatualizada")
    s = "\n".join(out)
    left = [m for l in out if code(l) for m in re.findall(r"127\.0\.0\.1:\d+", l)]
    if left:
        sys.exit(f"render: upstreams sem mapeamento: {sorted(set(left))}")
    head = ("# GERADO por staging/auth-gate/render-nginx.py — NÃO EDITAR.\n"
            "# Origem: nginx/bongo.dobslit.com.prod.conf + apply_nginx_authz.patch().\n"
            "# Diferenças para a VM: HTTP :80, nomes de serviço no lugar de 127.0.0.1, logs em stdout.\n\n")
    return head + s


def render_limits(text):
    keep = [l for l in text.splitlines() if re.match(r"\s*(#|limit_|$)", l)]  # a cópia trouxe `nginx version: …`
    out = "\n".join(keep).rstrip() + "\n"
    if out.count(NIST_RATE_PROD) != 1:
        sys.exit("render: zona kuapoa_nist_jobs inesperada")
    out = out.replace(NIST_RATE_PROD, NIST_RATE_TEST + "  # teste (prod: 2r/m) — ver render-nginx.py")
    return "# GERADO por render-nginx.py a partir de nginx/kuapoa-limits.prod.conf — NÃO EDITAR.\n" + out


def main():
    check = "--check" in sys.argv
    mod = load_patcher()
    prod = (NG / "bongo.dobslit.com.prod.conf").read_text(encoding="utf-8")
    patched = mod.patch(prod)
    if mod.patch(patched) != patched:
        sys.exit("render: patch não é idempotente")
    files = {
        "bongo.dobslit.com.patched.conf": patched,
        "default.conf": render_site(patched),
        "kuapoa-limits.conf": render_limits((NG / "kuapoa-limits.prod.conf").read_text(encoding="utf-8")),
    }
    OUT.mkdir(exist_ok=True)
    changed = []
    for name, body in files.items():
        p = OUT / name
        if not p.exists() or p.read_text(encoding="utf-8") != body:
            changed.append(name)
            if not check:
                p.write_text(body, encoding="utf-8", newline="\n")
    if check and changed:
        sys.exit(f"render --check: desatualizado: {changed}")
    print(f"render: {OUT} ({'alterados: ' + ', '.join(changed) if changed else 'sem mudanças'})")


if __name__ == "__main__":
    main()
