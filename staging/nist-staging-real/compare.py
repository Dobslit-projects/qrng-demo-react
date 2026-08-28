#!/usr/bin/env python3
"""Comparação paralela NIST: serviço PRODUTIVO x serviço de STAGING com a suíte
SP 800-90B REAL (fase item 7).

- Envia o MESMO arquivo (cópia somente-leitura) para os dois serviços.
- NÃO substitui o processo produtivo. NÃO modifica os arquivos originais.
- Coleta e compara ~20 campos por job; classifica cada diferença.

Uso:
  compare.py --prod http://127.0.0.1:18002 --real http://127.0.0.1:18093 \
             --file /path/para/copia.bin --test both --out /root/nist_compare.json
"""
import argparse
import hashlib
import json
import sys
import time
import urllib.request


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for c in iter(lambda: f.read(65536), b""):
            h.update(c)
    return h.hexdigest()


def _multipart(path, test_type, fmt):
    boundary = "----nistcompare" + hashlib.md5(path.encode()).hexdigest()[:12]
    with open(path, "rb") as f:
        data = f.read()
    fn = path.rsplit("/", 1)[-1]
    parts = []
    for name, val in (("test_type", test_type), ("format", fmt)):
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{val}\r\n".encode()
        )
    parts.append(
        (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{fn}\"\r\n"
         f"Content-Type: application/octet-stream\r\n\r\n").encode()
    )
    body = b"".join(parts) + data + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def _post_upload(base, path, test_type, fmt):
    body, ct = _multipart(path, test_type, fmt)
    req = urllib.request.Request(base.rstrip("/") + "/nist/upload", data=body,
                                 headers={"Content-Type": ct}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def _get(base, path):
    with urllib.request.urlopen(base.rstrip("/") + path, timeout=30) as r:
        return json.loads(r.read())


def _wait(base, job_id, timeout_s):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout_s:
        last = _get(base, f"/nist/jobs/{job_id}")
        if last.get("status") in ("completed", "failed"):
            return last
        time.sleep(3)
    return last


# campos comparados (contrato do item 7)
FIELDS = [
    "original_filename", "sha256_original", "sha256_used", "sha256_normalized",
    "size_original_bytes", "size_normalized_bytes", "normalized_symbol_count",
    "format_detected", "assessment_symbol_width", "normalization_method",
    "sample_endianness", "endianness_rule",
    "iid_passed", "chi_square_passed", "lrs_passed", "permutation_passed",
    "h_original_iid", "h_bitstring_iid", "h_min_iid",
    "h_original_non_iid", "h_bitstring_non_iid", "h_min_non_iid",
    "limiting_estimator", "duration_seconds", "status", "error_message",
    "assessment_engine", "synthetic_result",
]

# tolerância numérica para estimadores (float-store / -O2 / ordem de soma)
NUM_TOL = 1e-3


def _cmp(a, b):
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= NUM_TOL
    return a == b


def classify(field, pv, rv):
    if field in ("sha256_used", "sha256_normalized", "normalized_symbol_count",
                 "size_normalized_bytes", "endianness_rule", "first_parse_error"):
        return "normalização (versão corrigida persiste; baseline não)"
    if field in ("assessment_engine", "synthetic_result"):
        return "versão (identificação do motor — só na versão corrigida)"
    if field in ("h_original_iid", "h_bitstring_iid", "h_min_iid",
                 "h_original_non_iid", "h_bitstring_non_iid", "h_min_non_iid",
                 "limiting_estimator"):
        return "estimador (verificar: mesmo binário usado? mesma unidade de símbolo?)"
    if field == "duration_seconds":
        return "parâmetros (tempo de execução — não afeta resultado)"
    if field in ("format_detected", "assessment_symbol_width", "normalization_method",
                 "sample_endianness"):
        return "parser / unidade de símbolo"
    if field in ("status", "error_message"):
        return "bug OU arquivo efetivamente utilizado difere"
    return "verificar manualmente"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prod", required=True)
    ap.add_argument("--real", required=True)
    ap.add_argument("--file", required=True)
    ap.add_argument("--test", default="both")
    ap.add_argument("--fmt", default="auto")
    ap.add_argument("--timeout", type=int, default=2400)
    ap.add_argument("--out", default="/root/nist_compare.json")
    a = ap.parse_args()

    src_sha = _sha256(a.file)
    result = {
        "file": a.file, "file_sha256": src_sha, "test": a.test, "fmt": a.fmt,
        "prod_health": _get(a.prod, "/health"),
        "real_health": _get(a.real, "/health"),
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    print(f"[compare] arquivo {a.file}  sha256={src_sha}")
    print(f"[compare] enviando ao PRODUTIVO {a.prod} ...")
    up_p = _post_upload(a.prod, a.file, a.test, a.fmt)
    print(f"[compare]   job {up_p.get('job_id')}")
    print(f"[compare] enviando ao STAGING-REAL {a.real} ...")
    up_r = _post_upload(a.real, a.file, a.test, a.fmt)
    print(f"[compare]   job {up_r.get('job_id')}")

    print("[compare] aguardando os dois jobs (pode levar minutos)...")
    job_p = _wait(a.prod, up_p["job_id"], a.timeout)
    job_r = _wait(a.real, up_r["job_id"], a.timeout)
    result["prod_upload_response"] = up_p
    result["real_upload_response"] = up_r
    result["prod_job"] = job_p
    result["real_job"] = job_r

    diffs = []
    for f in FIELDS:
        pv, rv = job_p.get(f), job_r.get(f)
        if not _cmp(pv, rv):
            diffs.append({"field": f, "prod": pv, "real": rv, "classification": classify(f, pv, rv)})
    result["differences"] = diffs
    result["equivalent_statistically"] = all(
        d["field"] not in ("iid_passed", "h_min_iid", "h_min_non_iid",
                           "chi_square_passed", "lrs_passed", "permutation_passed")
        for d in diffs
    )

    with open(a.out, "w") as f:
        json.dump(result, f, indent=2, default=str)
    print(f"\n[compare] {len(diffs)} diferença(s). Detalhe em {a.out}")
    for d in diffs:
        print(f"  - {d['field']}: prod={d['prod']!r}  real={d['real']!r}  -> {d['classification']}")
    print(f"[compare] equivalência estatística: {result['equivalent_statistically']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
