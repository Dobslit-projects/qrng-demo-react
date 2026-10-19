#!/usr/bin/env python3
"""Testes do apply_nginx_authz.py contra uma CÓPIA da configuração de produção.

Rodar no WSL (docker disponível):
  python3 test_apply_nginx_authz.py -v
Variáveis: PROD_SITE / PROD_LIMITS (padrão: as cópias *.prod.conf ao lado), SKIP_DOCKER=1 (pula nginx -t real).
Nada de produção é tocado: tudo acontece num diretório temporário.
"""
import hashlib, http.server, importlib.util, os, pathlib, re, shlex, shutil, socket, subprocess
import sys, tempfile, threading, unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE / "apply_nginx_authz.py"
NGINX_T = HERE / "nginx_t_docker.sh"
PROD_SITE = pathlib.Path(os.environ.get("PROD_SITE", HERE / "bongo.dobslit.com.prod.conf"))
PROD_LIMITS = pathlib.Path(os.environ.get("PROD_LIMITS", HERE / "kuapoa-limits.prod.conf"))
SKIP_DOCKER = os.environ.get("SKIP_DOCKER") == "1"

spec = importlib.util.spec_from_file_location("apply_nginx_authz", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

TARGETS = {"= /qrng/api/stream", "= /qrng/api-fpga/stream",
           "~ ^/qrng/nist/nist/(upload|run)$", "/qrng/nist/", "/qrng/"}
NEW = {"= /_bongo_authz_qrng", "@qrng_forbidden_page", "@authz_unavailable_page",
       "@qrng_forbidden", "@qrng_identity_unavailable",
       "^~ /api/internal/", "~* ^/api/internal(/|$)",
       "^~ /qrng/v1/internal/v1/", "~* ^/qrng/v1/internal/v1(/|$)"}


def blocks(text):
    """{cabeçalho do location: texto do bloco} (todos os níveis do server)."""
    out = {}
    for m in re.finditer(r"^[ \t]*location\s+(.+?)\s*\{", text, re.M):
        i, depth = m.end(), 1
        while depth:
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            i += 1
        key = re.sub(r"\s+", " ", m.group(1))
        assert key not in out, key
        out[key] = text[m.start():i]
    return out


def outside_locations(text):
    """Texto fora de qualquer location (diretivas de server, comentários soltos)."""
    res, last = [], 0
    for m in re.finditer(r"^[ \t]*location\s+.+?\s*\{", text, re.M):
        if m.start() < last:
            continue
        res.append(text[last:m.start()])
        i, depth = m.end(), 1
        while depth:
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            i += 1
        last = i
    res.append(text[last:])
    return "".join(res)


def run(*args, cwd=None):
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, cwd=cwd)


def sha(p):
    return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class FakeBongo:
    """Responde `status` para GET /api/auth/authorize/qrng (pré-requisito)."""

    def __init__(self, status):
        st = status

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.server.seen.append((self.path, self.headers.get("Authorization")))
                self.send_response(st if self.path == "/api/auth/authorize/qrng" else 404)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a):
                pass

        self.port = free_port()
        self.srv = http.server.HTTPServer(("127.0.0.1", self.port), H)
        self.srv.seen = []
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


# Respostas de uma borda saudável depois do patch (o que o smoke espera).
EDGE_OK = {
    "/qrng/": (302, "/?redirect=/qrng/"),
    "/qrng/api/stream": (401, None),
    "/qrng/nist/health": (401, None),
    "/api/internal/v1/introspect": (404, None),
    "/qrng/v1/internal/v1/password-reset/1/status": (404, None),
    "/qrng/api/health": (200, None),
    "/edu/": (302, "/?redirect=/edu/"),
    "/redefinir-senha": (200, None),
    "/redefinir-senha-api": (200, None),
}


class FakeEdge:
    """Borda fictícia para o smoke pós-reload: `routes` = {caminho: (status, Location)}."""

    def __init__(self, routes):
        rt = dict(routes)

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.server.seen.append((self.path, self.headers.get("Cookie"), self.headers.get("Authorization")))
                st, loc = rt.get(self.path, (404, None))
                self.send_response(st)
                if loc:
                    self.send_header("Location", loc)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *a):
                pass

        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.srv = http.server.HTTPServer(("127.0.0.1", self.port), H)
        self.srv.seen = []
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


def py_cmd(code):
    """Comando portátil para --reload-cmd (sem depender de `true`/`false`)."""
    return f"{shlex.quote(sys.executable)} -c {shlex.quote(code)}"


def matching_location(blocks_by_key, path):
    """Location que o nginx escolheria para `path`: `=` exato; senão o prefixo mais
    longo (se for `^~`, vence); senão o primeiro regex na ordem do arquivo; senão o prefixo."""
    for k in blocks_by_key:
        if k.startswith("= ") and k[2:] == path:
            return k
    prefixes = []
    for k in blocks_by_key:
        if k.startswith("^~ "):
            prefixes.append((k[3:], k, True))
        elif not k.startswith(("=", "~", "@")):
            prefixes.append((k, k, False))
    best = max((x for x in prefixes if path.startswith(x[0])), key=lambda x: len(x[0]), default=None)
    if best and best[2]:
        return best[1]
    for k in blocks_by_key:  # dict preserva a ordem do arquivo
        if k.startswith("~* ") and re.search(k[3:], path, re.I):
            return k
        if k.startswith("~ ") and re.search(k[2:], path):
            return k
    return best[1] if best else None


class T(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp(prefix="authz-"))
        self.site = self.dir / "bongo.dobslit.com"
        shutil.copy2(PROD_SITE, self.site)
        self.orig = self.site.read_bytes()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def baks(self):
        return sorted(self.dir.glob("bongo.dobslit.com.bak-*"))

    # ---- funções puras ----
    def test_patch_is_idempotent(self):
        src = PROD_SITE.read_text(encoding="utf-8")
        once = mod.patch(src)
        self.assertNotEqual(once, src)
        self.assertEqual(mod.patch(once), once)

    def test_diff_touches_only_intended_blocks(self):
        src = PROD_SITE.read_text(encoding="utf-8")
        new = mod.patch(src)
        b0, b1 = blocks(src), blocks(new)
        self.assertEqual(set(b1) - set(b0), NEW)
        self.assertEqual(set(b0) - set(b1), set())
        for k in b0:
            if k in TARGETS:
                continue
            self.assertEqual(b0[k], b1[k], f"bloco alterado sem querer: location {k}")
        # dentro dos alvos, só auth_request/error_page (e comentários) mudam
        for k in TARGETS:
            old_l = [l for l in b0[k].splitlines() if not re.search(r"auth_request|error_page 401", l)]
            new_l = [l for l in b1[k].splitlines()
                     if not re.search(r"auth_request|error_page (401|403|500) =", l) and not l.strip().startswith("# doc 155") and not l.strip().startswith("# 500 (Bongo")]
            self.assertEqual(old_l, new_l, f"location {k}: mudou além do gate")
            self.assertIn("auth_request /_bongo_authz_qrng;", b1[k])
            self.assertNotIn("/_bongo_auth;", b1[k])
        # fora dos locations, só comentários novos e linhas em branco
        add = [l for l in difflib_lines(outside_locations(src), outside_locations(new)) if l.strip()]
        self.assertTrue(all(l.strip().startswith("#") for l in add), add)
        # /_bongo_auth e /edu/ intactos e ainda usados por /edu/
        self.assertIn("auth_request /_bongo_auth;", b1["/edu/"])
        self.assertEqual(b0["= /_bongo_auth"], b1["= /_bongo_auth"])

    def test_contract_of_new_blocks(self):
        b = blocks(mod.patch(PROD_SITE.read_text(encoding="utf-8")))
        g = b["= /_bongo_authz_qrng"]
        for s in ("internal;", "proxy_pass http://127.0.0.1:3101/api/auth/authorize/qrng;",
                  'proxy_set_header Authorization "Bearer $cookie_bongo_session";',
                  "proxy_pass_request_body off;", 'proxy_set_header Content-Length "";'):
            self.assertIn(s, g)
        self.assertIn("return 302 /cards?acesso=qrng;", b["@qrng_forbidden_page"])
        self.assertRegex(b["@authz_unavailable_page"], r"return 503 '<!doctype html>")
        self.assertIn('Cache-Control "no-store" always', b["@authz_unavailable_page"])
        self.assertIn("""return 403 '{"error":"FORBIDDEN","message":"Sua conta não tem acesso ao serviço QRNG."}';""", b["@qrng_forbidden"])
        self.assertIn("default_type application/json;", b["@qrng_forbidden"])
        self.assertRegex(b["@qrng_identity_unavailable"], r"""return 503 '\{"error":"IDENTITY_UNAVAILABLE",""")
        self.assertIn('Cache-Control "no-store" always', b["@qrng_identity_unavailable"])
        for k in ("^~ /api/internal/", "~* ^/api/internal(/|$)", "^~ /qrng/v1/internal/v1/", "~* ^/qrng/v1/internal/v1(/|$)"):
            self.assertIn("return 404 '{\"error\":\"NOT_FOUND\"", b[k])
            self.assertIn("default_type application/json;", b[k])
        for k in TARGETS - {"/qrng/"}:
            self.assertIn("error_page 401 = @qrng_unauth;", b[k])
            self.assertIn("error_page 403 = @qrng_forbidden;", b[k])
            self.assertIn("error_page 500 = @qrng_identity_unavailable;", b[k])
            self.assertNotIn("@bongo_login", b[k])
        p = b["/qrng/"]
        for s in ("error_page 401 = @bongo_login;", "error_page 403 = @qrng_forbidden_page;", "error_page 500 = @authz_unavailable_page;"):
            self.assertIn(s, p)

    def test_every_named_target_is_defined(self):
        """nginx -t NÃO verifica se o @nome de error_page existe — verificamos aqui."""
        new = mod.patch(PROD_SITE.read_text(encoding="utf-8"))
        defined = {k for k in blocks(new) if k.startswith("@")}
        used = set(re.findall(r"error_page[^;]*=\s*(@[\w]+)\s*;", new))
        self.assertTrue(used >= {"@qrng_forbidden", "@qrng_identity_unavailable", "@qrng_forbidden_page", "@authz_unavailable_page"})
        self.assertEqual(used - defined, set())

    def test_internal_blocks_precede_generic_prefixes(self):
        new = mod.patch(PROD_SITE.read_text(encoding="utf-8"))
        self.assertLess(new.index("location ^~ /api/internal/"), new.index("location /api/ {"))
        self.assertLess(new.index("location ^~ /qrng/v1/internal/v1/"), new.index("location /qrng/v1/ {"))

    def test_crlf_preserved(self):
        src = PROD_SITE.read_text(encoding="utf-8").replace("\n", "\r\n")
        new = mod.patch(src)
        self.assertNotIn("\n", new.replace("\r\n", ""))
        self.assertEqual(mod.patch(new), new)

    def test_refuses_partial_state(self):
        src = PROD_SITE.read_text(encoding="utf-8")
        broken = src.replace("location = /qrng/api/stream {\n        auth_request /_bongo_auth;",
                             "location = /qrng/api/stream {\n        auth_request /_bongo_authz_qrng;", 1)
        self.assertNotEqual(broken, src)
        with self.assertRaises(mod.PatchError):
            mod.patch(broken)

    def test_refuses_missing_anchor(self):
        src = PROD_SITE.read_text(encoding="utf-8").replace("location @bongo_login", "location @outro_nome")
        with self.assertRaises(mod.PatchError):
            mod.patch(src)

    # ---- páginas públicas de redefinição (links dos e-mails) ----
    def test_reset_pages_stay_outside_the_gate(self):
        """O caminho do link abre `location /` (front do portal), sem auth_request:
        o visitante anônimo precisa chegar à página com o #token=."""
        src = PROD_SITE.read_text(encoding="utf-8")
        new = mod.patch(src)
        b0, b1 = blocks(src), blocks(new)
        self.assertEqual(b0["/"], b1["/"])
        for path in ("/redefinir-senha", "/redefinir-senha-api"):
            k = matching_location(b1, path)
            self.assertEqual(k, "/", f"{path} cairia em location {k}")
            self.assertNotIn("auth_request", b1[k])
        # controle: o padrão antigo do link legado (/qrng/redefinir-senha) cai no gate
        k = matching_location(b1, "/qrng/redefinir-senha")
        self.assertEqual(k, "/qrng/")
        self.assertIn("auth_request /_bongo_authz_qrng;", b1[k])
        # o helper concorda com as regras já conhecidas do arquivo
        self.assertEqual(matching_location(b1, "/api/internal/v1/mail"), "^~ /api/internal/")
        self.assertEqual(matching_location(b1, "/api/INTERNAL/v1/mail"), "~* ^/api/internal(/|$)")
        self.assertEqual(matching_location(b1, "/qrng/api/stream"), "= /qrng/api/stream")
        self.assertEqual(matching_location(b1, "/qrng/nist/nist/run"), "~ ^/qrng/nist/nist/(upload|run)$")

    def test_refuses_if_root_location_would_change(self):
        src = PROD_SITE.read_text(encoding="utf-8")
        self.assertIn("/", mod.UNTOUCHED)
        out = mod.patch(src)
        mod.check_untouched(src, out)  # o patch real não mexe
        a, b = mod.require_block(out, "/")
        gated = out[:a] + out[a:b].replace("proxy_pass http://127.0.0.1:8081;",
                                           "auth_request /_bongo_authz_qrng;\n        proxy_pass http://127.0.0.1:8081;", 1) + out[b:]
        with self.assertRaisesRegex(mod.PatchError, r"`location /` mudaria"):
            mod.check_untouched(src, gated)

    # ---- reload + smoke (borda fictícia; nada de systemctl) ----
    def _apply(self, edge, reload_cmd):
        return run("--site", str(self.site), "--skip-precheck", "--nginx-test-cmd", "",
                   "--reload-cmd", reload_cmd, "--smoke-base", edge.base)

    def test_reload_and_smoke_ok_exit_0(self):
        edge = FakeEdge(EDGE_OK)
        try:
            r = self._apply(edge, py_cmd("raise SystemExit(0)"))
        finally:
            edge.close()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("nginx recarregado", r.stdout)
        self.assertIn("smoke: OK", r.stdout)
        self.assertLess(r.stdout.index("rollback: cp "), r.stdout.index("nginx recarregado"))
        paths = [p for p, _, _ in edge.srv.seen]
        self.assertEqual(sorted(set(paths)), sorted(EDGE_OK))
        self.assertEqual(paths.count("/redefinir-senha-api"), 2)  # sem cookie e com cookie inválido
        # o smoke não envia segredo: só o cookie inválido fixo, nunca Authorization
        self.assertEqual({c for _, c, _ in edge.srv.seen} - {None}, {"bongo_session=valor-invalido"})
        self.assertEqual({a for _, _, a in edge.srv.seen}, {None})

    def test_smoke_detects_open_gate_exit_4(self):
        edge = FakeEdge({**EDGE_OK, "/qrng/api/stream": (200, None)})
        try:
            r = self._apply(edge, py_cmd("raise SystemExit(0)"))
        finally:
            edge.close()
        self.assertEqual(r.returncode, 4, r.stdout + r.stderr)
        self.assertIn("smoke: DIVERGÊNCIA", r.stdout)
        self.assertIn("smoke FALHOU", r.stderr)
        self.assertIn(f"rollback: cp {self.baks()[0]} {self.site}", r.stderr)

    def test_smoke_detects_gated_reset_page_exit_4(self):
        edge = FakeEdge({**EDGE_OK, "/redefinir-senha-api": (302, "/?redirect=/redefinir-senha-api")})
        try:
            r = self._apply(edge, py_cmd("raise SystemExit(0)"))
        finally:
            edge.close()
        self.assertEqual(r.returncode, 4, r.stdout + r.stderr)
        self.assertRegex(r.stdout, r"ERR /redefinir-senha-api +→ 302")

    def test_reload_failure_exit_3_no_smoke(self):
        edge = FakeEdge(EDGE_OK)
        try:
            r = self._apply(edge, py_cmd("import sys; print('reload: falhou'); sys.exit(1)"))
        finally:
            edge.close()
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("reload FALHOU (exit 1)", r.stderr)
        self.assertIn("rollback: cp ", r.stdout)  # impresso antes do reload
        self.assertIn("rollback: cp ", r.stderr)
        self.assertNotIn("smoke", r.stdout)
        self.assertEqual(edge.srv.seen, [])
        self.assertEqual(len(self.baks()), 1)
        self.assertEqual(self.baks()[0].read_bytes(), self.orig)

    # ---- CLI ----
    def test_dry_run_writes_nothing(self):
        mtime = self.site.stat().st_mtime_ns
        r = run("--site", str(self.site), "--dry-run", "--skip-precheck")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("+    location = /_bongo_authz_qrng {", r.stdout)
        self.assertIn("--dry-run: nada gravado", r.stdout)
        self.assertEqual(self.site.read_bytes(), self.orig)
        self.assertEqual(self.site.stat().st_mtime_ns, mtime)
        self.assertEqual(self.baks(), [])
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["bongo.dobslit.com"])

    def _with_port(self, port):
        txt = self.site.read_text(encoding="utf-8").replace("127.0.0.1:3101", f"127.0.0.1:{port}")
        self.site.write_text(txt, encoding="utf-8")
        self.orig = self.site.read_bytes()

    def test_precheck_refuses_when_backend_not_deployed(self):
        fake = FakeBongo(404)  # Bongo antigo: rota não existe
        try:
            self._with_port(fake.port)
            r = run("--site", str(self.site), "--no-reload", "--nginx-test-cmd", "")
        finally:
            fake.close()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("nada alterado", r.stderr)
        self.assertEqual(self.site.read_bytes(), self.orig)
        self.assertEqual(self.baks(), [])
        self.assertEqual(fake.srv.seen, [("/api/auth/authorize/qrng", None)])  # sem token

    def test_precheck_refuses_when_backend_down(self):
        self._with_port(free_port())  # ninguém escutando
        r = run("--site", str(self.site), "--no-reload", "--nginx-test-cmd", "")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.site.read_bytes(), self.orig)
        self.assertEqual(self.baks(), [])

    def test_precheck_also_blocks_dry_run_exit_code(self):
        self._with_port(free_port())
        r = run("--site", str(self.site), "--dry-run")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.site.read_bytes(), self.orig)

    def test_precheck_accepts_401(self):
        fake = FakeBongo(401)
        try:
            self._with_port(fake.port)
            r = run("--site", str(self.site), "--no-reload", "--nginx-test-cmd", "")
        finally:
            fake.close()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"proxy_pass http://127.0.0.1:{fake.port}/api/auth/authorize/qrng;", self.site.read_text(encoding="utf-8"))

    def test_failed_nginx_t_restores_backup(self):
        r = run("--site", str(self.site), "--no-reload", "--skip-precheck", "--nginx-test-cmd", "false")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("backup restaurado", r.stderr)
        self.assertEqual(self.site.read_bytes(), self.orig)
        self.assertEqual(len(self.baks()), 1)
        self.assertEqual(self.baks()[0].read_bytes(), self.orig)

    def test_real_run_backup_rollback_and_idempotence(self):
        cmd = "true" if SKIP_DOCKER else f"bash {shlex.quote(str(NGINX_T))} {{site}} {shlex.quote(str(PROD_LIMITS))}"
        r = run("--site", str(self.site), "--no-reload", "--skip-precheck", "--nginx-test-cmd", cmd)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        if not SKIP_DOCKER:
            self.assertIn("test is successful", r.stdout)
        self.assertEqual(len(self.baks()), 1)
        bak = self.baks()[0]
        self.assertEqual(bak.read_bytes(), self.orig)
        self.assertIn(f"rollback: cp {bak} {self.site} && nginx -t && systemctl reload nginx", r.stdout)
        self.assertIn("--no-reload: nginx NÃO recarregado", r.stdout)
        patched = self.site.read_bytes()
        self.assertEqual(patched.decode("utf-8"), mod.patch(self.orig.decode("utf-8")))
        # segunda execução: nada muda, nenhum backup novo
        r2 = run("--site", str(self.site), "--no-reload", "--skip-precheck", "--nginx-test-cmd", "false")
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertIn("nada a alterar (já aplicado)", r2.stdout)
        self.assertEqual(self.site.read_bytes(), patched)
        self.assertEqual(len(self.baks()), 1)
        # rollback impresso funciona (cp do backup)
        shutil.copy2(bak, self.site)
        self.assertEqual(self.site.read_bytes(), self.orig)

    @unittest.skipIf(SKIP_DOCKER, "SKIP_DOCKER=1")
    def test_docker_nginx_t_detects_errors(self):
        """Controle negativo: o nginx -t em docker realmente reprova config quebrada."""
        bad = self.dir / "bad.conf"
        bad.write_text(mod.patch(self.orig.decode()).replace("return 302 /cards?acesso=qrng;", "retorne 302 /cards?acesso=qrng;", 1), encoding="utf-8")
        t = subprocess.run(["bash", str(NGINX_T), str(bad), str(PROD_LIMITS)], capture_output=True, text=True)
        self.assertNotEqual(t.returncode, 0, t.stdout + t.stderr)

    @unittest.skipIf(SKIP_DOCKER, "SKIP_DOCKER=1")
    def test_docker_nginx_t_baseline_original(self):
        t = subprocess.run(["bash", str(NGINX_T), str(self.site), str(PROD_LIMITS)], capture_output=True, text=True)
        self.assertEqual(t.returncode, 0, t.stdout + t.stderr)


def difflib_lines(a, b):
    import difflib
    return [l[1:] for l in difflib.ndiff(a.splitlines(), b.splitlines()) if l.startswith("+ ")]


if __name__ == "__main__":
    unittest.main()
