#!/usr/bin/env python3
"""Exemplo de uso da interface QRNG Open API do Kuapoã (só biblioteca padrão do Python 3.8+).

Variáveis de ambiente:
  QRNG_OPENAPI_URL   base das rotas (padrão: https://bongo.dobslit.com/qrng/v1)
  QRNG_API_TOKEN     token de API pessoal (dobslit_qrng_live_...), emitido no portal; obrigatório
  QRNG_AUTH_HEADER   "bearer" (padrão) ou "x-api-key"

Uso:
  export QRNG_API_TOKEN=...      # nunca coloque o token no código nem no histórico do git
  python3 qrng_open_api_example.py

O exemplo pede volumes pequenos (32 B e 4 x 64 B). Cada chamada conta na cota diária do seu token, a mesma
cota de GET /v1/random.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("QRNG_OPENAPI_URL", "https://bongo.dobslit.com/qrng/v1").rstrip("/")
TOKEN = os.environ.get("QRNG_API_TOKEN", "")
AUTH_MODE = os.environ.get("QRNG_AUTH_HEADER", "bearer").lower()


class QrngOpenApiError(Exception):
    """Erro devolvido pela API, com o código HTTP, o código de erro e o request_id para suporte."""

    def __init__(self, status, payload, headers):
        self.status = status
        self.payload = payload if isinstance(payload, dict) else {}
        self.error = self.payload.get("error", "HTTP_%d" % status)
        self.request_id = self.payload.get("request_id") or headers.get("X-Request-Id")
        self.retry_after = headers.get("Retry-After")
        super().__init__("%d %s: %s (request_id=%s)" % (status, self.error, self.payload.get("message", ""), self.request_id))


def _request(method, path, body=None, token=None):
    headers = {"Accept": "application/json"}
    tok = TOKEN if token is None else token
    if tok:
        if AUTH_MODE == "x-api-key":
            headers["X-API-Key"] = tok
        else:
            headers["Authorization"] = "Bearer " + tok
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {}
        raise QrngOpenApiError(e.code, payload, dict(e.headers)) from None


def with_retries(fn, attempts=3):
    """Repete só o que é temporário: 429 (respeita Retry-After) e 503 (fonte indisponível agora)."""
    for i in range(attempts):
        try:
            return fn()
        except QrngOpenApiError as e:
            if e.status not in (429, 503) or i == attempts - 1:
                raise
            if e.status == 429 and e.error in ("QUOTA_EXCEEDED", "QUOTA_BYTES_EXCEEDED"):
                raise  # cota diária: só volta à meia-noite UTC, não adianta repetir
            wait = float(e.retry_after) if e.retry_after else 2.0 * (i + 1)
            print("  temporário (%s); nova tentativa em %.0f s" % (e.error, wait))
            time.sleep(wait)


def capabilities():
    return _request("GET", "/capabilities")


def entropy(block_size, block_count=None, entropy_type=None):
    """Pede block_count blocos de block_size bytes e devolve uma lista de bytes, conferindo os tamanhos."""
    body = {"block_size": block_size}
    if block_count is not None:
        body["block_count"] = block_count
    if entropy_type is not None:
        body["entropy_type"] = entropy_type
    resp = _request("POST", "/entropy", body)
    blocks = [base64.b64decode(b, validate=True) for b in resp["entropy"]]
    expected = 1 if block_count is None else block_count
    if len(blocks) != expected or any(len(b) != block_size for b in blocks):
        raise RuntimeError("resposta fora do contrato: %d blocos, tamanhos %s" % (len(blocks), [len(b) for b in blocks]))
    return blocks, resp.get("extensions", [])


def healthtest():
    return _request("GET", "/healthtest")


def extension(exts, name):
    return next((e.get("data") for e in exts if isinstance(e, dict) and e.get("name") == name), None)


def main():
    if not TOKEN:
        sys.exit("Defina QRNG_API_TOKEN com o seu token de API (portal Kuapoã → Desenvolvedor).")
    print("Base:", BASE)

    # 1. capacidades
    caps = with_retries(capabilities)
    e = caps["entropy"]
    limits = extension(e.get("extensions", []), "kuapoa.limits") or {}
    print("1. capacidades: bloco %d..%d B, %d..%d blocos, total máximo %s B, tipos %s"
          % (e.get("min_block_size", 1), e["max_block_size"], e.get("min_block_count", 1), e["max_block_count"],
             limits.get("max_total_bytes", "?"), e.get("entropy_types")))

    # 2. um bloco de 32 bytes (block_count e entropy_type nos valores padrão)
    blocks, exts = with_retries(lambda: entropy(32))
    meta = extension(exts, "kuapoa.response") or {}
    print("2. um bloco: %d bloco de %d B (início %s…), request_id=%s, conditioned=%s"
          % (len(blocks), len(blocks[0]), blocks[0][:4].hex(), meta.get("request_id"), meta.get("conditioned")))

    # 3. vários blocos: 4 x 64 bytes, respeitando o total anunciado
    total_max = limits.get("max_total_bytes", 64 * 4)
    count = min(4, total_max // 64)
    blocks, exts = with_retries(lambda: entropy(64, count))
    print("3. vários blocos: %d blocos, tamanhos %s" % (len(blocks), [len(b) for b in blocks]))

    # 4. saúde: cada item é uma observação atual, com o instante em que foi feita
    h = with_retries(healthtest)
    print("4. healthtest:")
    for t in h["test_result"]:
        print("   %-34s %-28s %s" % (t["test_type"], t["test_result"], t["time_stamp"]))
    if extension(h.get("extensions", []), "kuapoa.historical_assessment"):
        print("   (há uma avaliação histórica na extensão kuapoa.historical_assessment; ela não é saúde em tempo real)")

    # 5. tratamento de erros
    print("5. erros:")
    try:
        _request("POST", "/entropy", {"block_size": "32"})  # string em vez de número
    except QrngOpenApiError as err:
        print("   parâmetro inválido →", err.status, err.error)
    try:
        _request("GET", "/capabilities", token="")  # sem credencial
    except QrngOpenApiError as err:
        print("   sem token →", err.status, err.error)
    try:
        _request("POST", "/entropy", {"block_size": e["max_block_size"] + 1})
    except QrngOpenApiError as err:
        print("   acima do limite →", err.status, err.error)
    print("   cota ou limite por minuto → 429 (QUOTA_EXCEEDED, QUOTA_BYTES_EXCEEDED ou RATE_LIMIT_EXCEEDED + Retry-After)")
    print("   fonte indisponível → 503 (QRNG_UNAVAILABLE, INSUFFICIENT_ENTROPY ou SOURCE_OFFLINE); nenhum bloco é entregue")


if __name__ == "__main__":
    try:
        main()
    except QrngOpenApiError as err:
        sys.exit("Erro da API: %s" % err)
