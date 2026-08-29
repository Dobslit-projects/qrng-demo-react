#!/usr/bin/env python3
"""
Kapuã QRNG — exemplo de uso da API pública com token pessoal.

Contrato real da produção (verificado em 2026-08-29 contra
https://bongo.dobslit.com/qrng/v1 — frontend qrng-web:9e36a90, API
qrng-client-api:4137bfe):

  GET /v1/random?bytes=N&format=hex|base64|uint8   -> application/json (RandomResponse)
  GET /v1/random?bytes=N&format=raw                -> application/octet-stream (N bytes exatos)
  GET /v1/raw?bytes=N                              -> idem raw, rota dedicada
  GET /v1/health                                   -> JSON (status do client-api + upstream)
  GET /v1/me/usage                                 -> cota e uso do token
  GET /v1/me/requests?limit=N                      -> histórico de chamadas do token

Autenticação: header  Authorization: Bearer <API_TOKEN>
  O token pessoal tem o formato  dobslit_qrng_live_<hex>  e é emitido na aba
  "Desenvolvedor > Token" do portal (POST /v1/tokens). Ele AUTENTICA o acesso e
  contabiliza cota — NÃO altera, condiciona nem melhora os bytes aleatórios.

Limites (produção, 2026-08-29):
  - /v1/random com token: até 1 048 576 bytes por requisição (1 MiB).
  - /v1/public/random sem token: até 65 536 bytes; rate limit ~20 req / 60 s por IP.
  - Cota diária do token: ver GET /v1/me/usage (reseta à meia-noite UTC).

Proveniência: a produção informa hoje, de forma intencional,
  provenance = "unknown", live_verified = false, captured_at = null
enquanto a origem física da fonte não puder ser comprovada. Ver o guia do usuário.

Uso:
  export KAPUA_API_TOKEN="dobslit_qrng_live_xxxxxxxx..."   # NUNCA comite o token
  python kapua_api_example.py
"""
from __future__ import annotations

import base64
import hashlib
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://bongo.dobslit.com/qrng/v1"
PUBLIC_BASE_URL = "https://bongo.dobslit.com/qrng/v1/public"  # sem token, cota reduzida

# Placeholder — substitua pelo seu token OU exporte KAPUA_API_TOKEN no ambiente.
# Nunca escreva um token real no código.
API_TOKEN = os.environ.get("KAPUA_API_TOKEN", "SEU_TOKEN_AQUI")
HAVE_TOKEN = API_TOKEN not in ("", "SEU_TOKEN_AQUI")

TIMEOUT_S = 30


class KapuaError(RuntimeError):
    def __init__(self, status: int, error: str, message: str, request_id: str | None):
        super().__init__(f"[{status}] {error}: {message} (request_id={request_id})")
        self.status = status
        self.error = error
        self.message = message
        self.request_id = request_id


def _request(path: str, params: dict | None = None, *, binary: bool = False, public: bool = False):
    """GET. Retorna (headers, corpo). corpo = bytes se binary, senão dict JSON.

    Com token (HAVE_TOKEN): usa BASE_URL e o header Authorization.
    Sem token: cai para o endpoint público equivalente (só /random e /raw têm
    versão pública; /health, /me/* exigem token e são puladas)."""
    use_public = public or not HAVE_TOKEN
    base = PUBLIC_BASE_URL if use_public else BASE_URL
    url = f"{base}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method="GET")
    if not use_public:
        req.add_header("Authorization", f"Bearer {API_TOKEN}")  # <-- autenticação
    req.add_header("Accept", "application/octet-stream" if binary else "application/json")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            headers = {k.lower(): v for k, v in resp.headers.items()}
            raw = resp.read()
            if binary:
                return headers, raw
            import json
            return headers, json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            import json
            j = json.loads(body)
        except ValueError:
            j = {}
        raise KapuaError(
            e.code,
            j.get("error", "HTTP_ERROR"),
            j.get("message", body[:200]),
            j.get("request_id"),
        ) from None
    except urllib.error.URLError as e:
        # rede indisponível / DNS / TLS / timeout
        raise KapuaError(0, "NETWORK", str(e.reason), None) from None


def print_provenance(headers: dict, detail: dict | None) -> None:
    """Mostra a proveniência SEM jamais representar 'unknown' como 'live'."""
    prov = (detail or {}).get("actual_origin") or headers.get("x-qrng-provenance") or "unknown"
    live = (detail or {}).get("live_verified")
    if live is None:
        live = headers.get("x-qrng-live-verified") == "true"
    captured = (detail or {}).get("captured_at") if detail else headers.get("x-qrng-captured-at")
    print(f"  proveniência efetiva : {prov}")
    print(f"  live_verified        : {bool(live)}")
    print(f"  captured_at          : {captured!r}")
    print(f"  transport_health     : {(detail or {}).get('transport_health') or headers.get('x-qrng-transport-health')}")
    print(f"  buffer_health        : {(detail or {}).get('buffer_health') or headers.get('x-qrng-buffer-health')}")
    print(f"  entropy_health       : {(detail or {}).get('entropy_health') or headers.get('x-qrng-entropy-health')}")
    if prov != "live":
        print("  NOTA: esta resposta NÃO é uma captura live verificada.")


def health() -> None:
    print("== GET /v1/health ==")
    if not HAVE_TOKEN:
        print("  (pulado: exige token; sem KAPUA_API_TOKEN definido)")
        return
    try:
        headers, body = _request("/health")
    except KapuaError as e:
        print(f"  indisponível: {e}")
        return
    print(f"  status={body.get('status')}  api={body.get('api')}  request_id={body.get('request_id')}")
    up = body.get("upstream") or {}
    for k in ("source_status", "buffer_bytes_available", "stream_format", "sample_width_bytes", "conditioned"):
        if k in up:
            print(f"  upstream.{k} = {up[k]!r}")


def random_bytes(n: int) -> bytes:
    """N bytes brutos via format=raw (application/octet-stream, N bytes exatos)."""
    print(f"== GET /v1/random?bytes={n}&format=raw ==")
    headers, data = _request("/random", {"bytes": n, "format": "raw"}, binary=True)
    assert len(data) == n, f"esperado {n} bytes, recebido {len(data)}"
    print(f"  recebidos {len(data)} bytes  (Content-Length={headers.get('content-length')})")
    print(f"  request_id: {headers.get('x-request-id')}")
    print(f"  SHA-256   : {hashlib.sha256(data).hexdigest()}")
    print_provenance(headers, None)
    return data


def random_hex(n: int) -> bytes:
    print(f"== GET /v1/random?bytes={n}&format=hex ==")
    headers, body = _request("/random", {"bytes": n, "format": "hex"})
    hex_str = body["random"]
    assert len(hex_str) == 2 * n, "hex deve ter 2 caracteres por byte"
    data = bytes.fromhex(hex_str)
    print(f"  hex[:32] = {hex_str[:32]}")
    print(f"  {len(data)} bytes  SHA-256={hashlib.sha256(data).hexdigest()}")
    print(f"  request_id: {body.get('request_id')}")
    print_provenance(headers, body.get("provenance_detail"))
    return data


def random_base64(n: int) -> bytes:
    print(f"== GET /v1/random?bytes={n}&format=base64 ==")
    headers, body = _request("/random", {"bytes": n, "format": "base64"})
    data = base64.b64decode(body["random"])
    assert len(data) == n
    print(f"  base64[:24] = {body['random'][:24]}")
    print(f"  {len(data)} bytes  SHA-256={hashlib.sha256(data).hexdigest()}")
    return data


def random_uint8(n: int) -> bytes:
    print(f"== GET /v1/random?bytes={n}&format=uint8 ==")
    headers, body = _request("/random", {"bytes": n, "format": "uint8"})
    arr = body["random"]
    assert isinstance(arr, list) and len(arr) == n
    assert all(isinstance(v, int) and 0 <= v <= 255 for v in arr), "uint8 fora de 0..255"
    data = bytes(arr)
    print(f"  uint8[:16] = {arr[:16]}")
    print(f"  {len(data)} bytes  SHA-256={hashlib.sha256(data).hexdigest()}")
    return data


def save_bin(data: bytes, path: str = "kapua_sample.bin") -> None:
    with open(path, "wb") as f:
        f.write(data)
    print(f"== salvo {len(data)} bytes em {path} ==")


def usage() -> None:
    print("== GET /v1/me/usage ==")
    if not HAVE_TOKEN:
        print("  (pulado: exige token)")
        return
    try:
        _, body = _request("/me/usage")
    except KapuaError as e:
        print(f"  {e}")
        return
    for k in ("quota_daily", "requests_today", "bytes_today", "requests_7d", "requests_30d"):
        if k in body:
            print(f"  {k} = {body[k]}")


def demo_error_handling() -> None:
    """Mostra o tratamento de 401 / 429 / 503 sem derrubar o programa."""
    print("== tratamento de erros ==")
    # Sem header Authorization        -> 401 MISSING_TOKEN
    # Header presente mas token ruim  -> 403 INVALID_TOKEN
    bad = urllib.request.Request(f"{BASE_URL}/random?bytes=8&format=hex")
    bad.add_header("Authorization", "Bearer token-invalido")
    try:
        urllib.request.urlopen(bad, timeout=TIMEOUT_S)
    except urllib.error.HTTPError as e:
        print(f"  token inválido -> HTTP {e.code}  corpo={e.read()[:120]!r}")
    # 429 (rate limit / cota) e 503 (upstream/entropia): capturados por KapuaError
    for label in ("429 (cota/rate limit)", "503 (upstream/entropia)"):
        print(f"  {label}: capture KapuaError e faça backoff exponencial; "
              f"não trate como sucesso, não reutilize bytes antigos.")


def main() -> int:
    if not HAVE_TOKEN:
        print("KAPUA_API_TOKEN não definido — usando os endpoints PÚBLICOS "
              "(/v1/public/random, cota reduzida, sem /health nem /me/*).\n"
              "Para o fluxo autenticado: export KAPUA_API_TOKEN=\"dobslit_qrng_live_...\" "
              "(NUNCA comite um token real).\n", file=sys.stderr)
    health()
    print()
    raw = random_bytes(64)
    print()
    _ = random_hex(64)
    _ = random_base64(64)
    _ = random_uint8(64)
    print()
    # ATENÇÃO: raw, from_hex, from_b64, from_u8 vêm de CHAMADAS INDEPENDENTES e
    # portanto são amostras DIFERENTES — não compare os bytes entre si. A
    # equivalência dos formatos é provada com uma amostra única/fixture, não com
    # 4 chamadas live (ver docs/USER_GUIDE_EVIDENCE_MATRIX.md).
    save_bin(raw, "kapua_sample.bin")
    print()
    usage()
    print()
    demo_error_handling()
    print()
    print("Lembre-se: o token autentica e mede cota; não melhora a entropia. "
          "A caracterização física e a validação operacional da fonte continuam em andamento.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
