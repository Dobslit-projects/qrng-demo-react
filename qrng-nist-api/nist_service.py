#!/usr/bin/env python3
"""
QRNG NIST SP 800-90B Validation Service
Runs on Recife VM (dobslit@192.168.0.224) at port 8002
"""
import os, re, uuid, time, hashlib, json, struct, threading, logging, shutil, tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
import sqlite3
import subprocess
import queue as queue_module

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware

# ── Identidade da versão (item 5 da fase de estabilização) ──────────────────────
# Injetados no build/deploy. O /health expõe os três para que staging e produção
# nunca sejam confundidos e para que um teste possa afirmar "estou falando com o
# commit X". Nunca inferidos — se não forem passados, ficam "unknown".
SERVICE_VERSION    = os.getenv("NIST_SERVICE_VERSION",    "1.1.0-staging-candidate")
SERVICE_COMMIT     = os.getenv("NIST_SERVICE_COMMIT",     "unknown")
SERVICE_BUILD_DATE = os.getenv("NIST_SERVICE_BUILD_DATE", "unknown")
SERVICE_ENV        = os.getenv("NIST_SERVICE_ENV",        "unknown")  # 'staging' | 'production' | ...

# ── Config ──────────────────────────────────────────────────────────────────────

NIST_ENABLED       = os.getenv("NIST_ENABLED",        "true").lower() == "true"
NIST_SUITE_DIR     = os.getenv("NIST_SUITE_DIR",      "/home/dobslit/SP800-90B_EntropyAssessment/cpp")
NIST_SCRIPT        = os.getenv("NIST_SCRIPT",         "/home/dobslit/SP800-90B_EntropyAssessment/cpp/qrng_nist90b.sh")
NIST_DATA_DIR      = os.getenv("NIST_DATA_DIR",       "/home/dobslit/qrng_data_nist")
NIST_INTERVAL_SEC  = int(os.getenv("NIST_TEST_INTERVAL_SECONDS", "300"))
NIST_TIMEOUT_SEC   = int(os.getenv("NIST_TEST_TIMEOUT_SECONDS",  "1800"))
NIST_MAX_UPLOAD_MB = int(os.getenv("NIST_MAX_UPLOAD_MB", "200"))
NIST_MIN_BYTES     = int(os.getenv("NIST_MIN_BYTES", "1000000"))  # >= 1M samples required by NIST SP 800-90B; overridable only for staging
NIST_UPLOAD_DIR    = os.path.join(NIST_DATA_DIR, "uploads")
DB_PATH            = os.getenv("NIST_DB_PATH", "/home/dobslit/qrng-nist-api/nist.db")

# ── Política de upload (item 5) ────────────────────────────────────────────────
# Limite explícito de 128 MiB, streaming para arquivo temporário (o corpo NUNCA
# é lido inteiro em memória), extensões restritas, limpeza segura do temporário.
NIST_UPLOAD_MAX_BYTES = int(os.getenv("NIST_UPLOAD_MAX_BYTES", str(128 * 1024 * 1024)))
NIST_UPLOAD_CHUNK     = int(os.getenv("NIST_UPLOAD_CHUNK_BYTES", str(1024 * 1024)))
NIST_ALLOWED_UPLOAD_EXT = {".bin", ".txt", ".csv"}

# Auditoria do pipeline QRNG (2026-08-25, item 2): sem um mecanismo de
# captura ao vivo CONTROLADA (que grava amostras frescas do stream com
# proveniência conhecida em um local dedicado), o job periódico não deve
# rodar -- ele ficava preso reavaliando arquivos estáticos de exercícios
# de auditoria manual antigos, apresentados como se fossem saúde atual do
# stream. Desabilitado por padrão até NIST_LIVE_CAPTURE_PATH ser
# configurado para apontar a um mecanismo real de captura (não
# implementado nesta auditoria -- é uma lacuna de infraestrutura
# separada). Quando desabilitado, /nist/status expõe isso explicitamente
# e nenhum job "periodic_live" é criado.
NIST_LIVE_CAPTURE_PATH = os.getenv("NIST_LIVE_CAPTURE_PATH", "").strip() or None

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("nist")

for d in [NIST_UPLOAD_DIR, os.path.dirname(DB_PATH)]:
    Path(d).mkdir(parents=True, exist_ok=True)

# ── Database ────────────────────────────────────────────────────────────────────

_db_lock = threading.Lock()
_db_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_db_conn.row_factory = sqlite3.Row
_db_conn.execute("PRAGMA journal_mode=WAL")

_db_conn.execute("""
    CREATE TABLE IF NOT EXISTS nist_test_jobs (
        id                   TEXT PRIMARY KEY,
        created_at           TEXT NOT NULL,
        started_at           TEXT,
        finished_at          TEXT,
        status               TEXT NOT NULL DEFAULT 'queued',
        trigger_type         TEXT NOT NULL,
        input_file_path      TEXT,
        original_filename    TEXT,
        normalized_file_path TEXT,
        format_requested     TEXT,
        format_detected      TEXT,
        test_type            TEXT,
        sha256_original      TEXT,
        sha256_used          TEXT,
        iid_passed           INTEGER,
        chi_square_passed    INTEGER,
        lrs_passed           INTEGER,
        permutation_passed   INTEGER,
        h_original_iid       REAL,
        h_bitstring_iid      REAL,
        h_min_iid            REAL,
        h_original_non_iid   REAL,
        h_bitstring_non_iid  REAL,
        h_min_non_iid        REAL,
        limiting_estimator   TEXT,
        estimators_json      TEXT,
        stdout_path          TEXT,
        stderr_path          TEXT,
        result_dir           TEXT,
        error_message        TEXT,
        duration_seconds     REAL
    )
""")
_db_conn.commit()

# Migrações não-destrutivas (item 2 da auditoria: metadados persistidos no
# momento da submissão, nunca inferidos depois por nome/diretório/mtime).
# sample_origin:            'periodic_live' | 'user_upload' |
#                            'historical_assessment' | 'restart_campaign' | NULL(=unknown)
# transport_format:         'uint32-le' | NULL(=unknown) -- só setado quando a
#                            proveniência da amostra é conhecida como vinda do
#                            pipeline atual; NUNCA assumido por padrão.
# source_word_width:        4 | NULL(=unknown), em bytes
# assessment_symbol_width:  8 | 1 | NULL -- o que foi de fato passado a
#                            ea_iid/ea_non_iid (bits_per_symbol), determinado
#                            a partir de format_detected dentro de _run_job.
# normalization_method:     'raw-passthrough' | 'byte-decomposition-le-uint32'
#                            | 'bit-extraction' | NULL(=unknown)
# sample_endianness:        'little' | NULL(=unknown/not-applicable)
# sample_conditioned:       0 | 1 | NULL(=unknown) -- mesma convenção 0/1 dos
#                            demais campos booleanos desta tabela
# captured_at:               ISO8601 ou NULL -- quando a amostra foi
#                            fisicamente produzida (proxy: mtime do arquivo no
#                            momento da submissão, quando conhecido; NUNCA
#                            relido depois). created_at já funciona como
#                            submitted_at (quando o job foi enfileirado).
for _col, _decl in [
    ("sample_origin",            "TEXT"),
    ("transport_format",         "TEXT"),
    ("source_word_width",        "INTEGER"),
    ("assessment_symbol_width",  "INTEGER"),
    ("normalization_method",     "TEXT"),
    ("sample_endianness",        "TEXT"),
    ("sample_conditioned",       "INTEGER"),
    ("captured_at",              "TEXT"),
]:
    try:
        _db_conn.execute(f"ALTER TABLE nist_test_jobs ADD COLUMN {_col} {_decl}")
        _db_conn.commit()
    except sqlite3.OperationalError:
        pass  # coluna já existe (migração idempotente)

def _db(sql, params=()):
    with _db_lock:
        _db_conn.execute(sql, params)
        _db_conn.commit()

def _db_one(sql, params=()):
    with _db_lock:
        return _db_conn.execute(sql, params).fetchone()

def _db_all(sql, params=()):
    with _db_lock:
        return _db_conn.execute(sql, params).fetchall()

# ── Job queue (single worker) ───────────────────────────────────────────────────

_job_q = queue_module.Queue()

def _worker():
    while True:
        job_id = _job_q.get()
        try:
            _run_job(job_id)
        except Exception as e:
            log.error(f"[worker] job {job_id} crashed: {e}")
            _db(
                "UPDATE nist_test_jobs SET status='failed', error_message=?, finished_at=? WHERE id=?",
                (str(e), _now(), job_id)
            )
        finally:
            _job_q.task_done()

threading.Thread(target=_worker, daemon=True, name="nist-worker").start()

# ── Helpers ─────────────────────────────────────────────────────────────────────

def _now(): return datetime.now(timezone.utc).isoformat()

def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""): h.update(chunk)
    return h.hexdigest()

def _safe_name(name: str) -> str:
    name = os.path.basename(name)
    name = re.sub(r"[^\w\-_.]", "_", name)
    return name[:200] or "upload"

def _safe_unlink(path: Optional[str]) -> None:
    """Remove um temporário/parcial sem nunca levantar (limpeza best-effort)."""
    if not path:
        return
    try:
        os.unlink(path)
    except OSError:
        pass

def _validate_upload_content(path: str, ext: str) -> tuple:
    """Validação de conteúdo mínima e barata por extensão. Retorna (ok, motivo).
    NÃO tenta validar entropia — só que o arquivo é plausivelmente do tipo
    declarado, para rejeitar cedo lixo óbvio (ex.: HTML/― binário como .txt)."""
    try:
        with open(path, "rb") as f:
            head = f.read(4096)
    except OSError as e:
        return False, f"não foi possível ler o arquivo salvo: {e}"
    if not head:
        return False, "arquivo vazio"
    if ext == ".bin":
        return True, "ok"  # qualquer byte é válido em amostra binária crua
    # .txt / .csv: precisa ser texto decodificável e conter ao menos um dígito
    try:
        text = head.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = head.decode("latin-1")
        except UnicodeDecodeError:
            return False, "conteúdo não decodificável como texto"
    if "\x00" in text:
        return False, "NUL byte em arquivo de texto"
    if not any(c.isdigit() for c in text):
        return False, "nenhum dígito numérico nos primeiros 4096 bytes"
    return True, "ok"

def _normalization_for_ext(ext: str) -> str:
    # Confirmado lendo qrng_nist90b.sh (baseline item 5): .bin -> passthrough
    # (símbolos de 8 bits), .txt/.csv de inteiros uint32 -> cada valor vira 4
    # bytes little-endian antes da avaliação (ainda símbolos de 8 bits).
    if ext == ".bin":
        return "raw-passthrough"
    if ext in (".txt", ".csv"):
        return "byte-decomposition-le-uint32"
    return "unknown"

def _find_latest_data_file() -> Optional[str]:
    # Auditoria do pipeline QRNG (2026-08-25): "audit*" e "characterization_*"
    # dentro de NIST_DATA_DIR são artefatos de exercícios manuais pontuais
    # (ex.: audit52/C01_digits_B01.bin, criado em 2026-08-13, ANTES da
    # reescrita de server_api.py para uint32-LE em 2026-08-15 -- um formato
    # já obsoleto) -- não são capturas automáticas do stream ao vivo. Sem
    # excluí-los, o job periódico ficava preso reavaliando repetidamente o
    # mesmo arquivo estático e desatualizado, apresentado como se fosse a
    # saúde atual da fonte. NÃO existe hoje nenhum processo que capture
    # automaticamente amostras frescas do stream ao vivo para este
    # diretório -- isso é uma lacuna de infraestrutura, não corrigida aqui
    # (fora do escopo desta auditoria); até que exista, o job periódico
    # pode legitimamente não encontrar nenhum arquivo adequado.
    EXCLUDED_PATTERNS = ["uploads", "results_", ".log", ".lost", "sha256", "audit", "characterization_"]
    candidates = []
    for ext in ["*.txt", "*.bin"]:
        for p in Path(NIST_DATA_DIR).rglob(ext):
            s = str(p).lower()
            if any(x in s for x in EXCLUDED_PATTERNS):
                continue
            try:
                if p.stat().st_size >= NIST_MIN_BYTES:
                    candidates.append(p)
            except OSError:
                pass
    if not candidates:
        return None
    return str(max(candidates, key=lambda p: p.stat().st_mtime))

# ── CSV converter ───────────────────────────────────────────────────────────────

def _csv_to_u32txt(src: str, dst: str) -> int:
    with open(src, "r", errors="replace") as f:
        content = f.read()
    for sep in [",", ";", "\t", " "]:
        content = content.replace(sep, "\n")
    vals = []
    for line in content.splitlines():
        t = line.strip()
        if not t:
            continue
        try:
            v = int(t)
            if 0 <= v <= 4294967295:
                vals.append(v)
        except ValueError:
            pass  # skip header/non-numeric
    if not vals:
        raise ValueError("CSV: nenhum inteiro uint32 válido encontrado")
    with open(dst, "w") as f:
        f.write("\n".join(str(v) for v in vals) + "\n")
    return len(vals)

# ── Output parser ───────────────────────────────────────────────────────────────

def _parse_output(stdout: str, test_type: str) -> dict:
    r = {
        "h_original_iid": None, "h_bitstring_iid": None, "h_min_iid": None,
        "iid_passed": None, "chi_square_passed": None, "lrs_passed": None,
        "permutation_passed": None,
        "h_original_non_iid": None, "h_bitstring_non_iid": None, "h_min_non_iid": None,
        "limiting_estimator": None, "estimators": {},
    }

    # Split stdout into IID and non-IID sections
    iid_text = non_iid_text = stdout

    if "Rodando IID" in stdout and "Rodando non-IID" in stdout:
        parts = re.split(r"Rodando non-IID\.\.\.", stdout, maxsplit=1)
        iid_text     = parts[0]
        non_iid_text = parts[1] if len(parts) > 1 else ""
    elif "Rodando IID" in stdout:
        iid_text     = stdout
        non_iid_text = ""
    elif "Rodando non-IID" in stdout:
        iid_text     = ""
        non_iid_text = stdout

    def _extract(text, key):
        m = re.search(key, text)
        return float(m.group(1)) if m else None

    # IID
    if test_type in ("iid", "both") and iid_text:
        r["h_original_iid"]    = _extract(iid_text, r"H_original:\s*([\d.]+)")
        r["h_bitstring_iid"]   = _extract(iid_text, r"H_bitstring:\s*([\d.]+)")
        r["h_min_iid"]         = _extract(iid_text, r"min\(H_original,\s*8\s*[Xx]\s*H_bitstring\):\s*([\d.]+)")
        r["chi_square_passed"]  = "Passed chi square tests"                          in iid_text
        r["lrs_passed"]         = "Passed length of longest repeated substring test" in iid_text
        r["permutation_passed"] = "Passed IID permutation tests"                     in iid_text
        r["iid_passed"]         = bool(r["chi_square_passed"] and r["lrs_passed"] and r["permutation_passed"])

    # non-IID
    if test_type in ("non_iid", "both") and non_iid_text:
        r["h_original_non_iid"]  = _extract(non_iid_text, r"H_original:\s*([\d.]+)")
        r["h_bitstring_non_iid"] = _extract(non_iid_text, r"H_bitstring:\s*([\d.]+)")
        r["h_min_non_iid"]       = _extract(non_iid_text, r"min\(H_original,\s*8\s*[Xx]\s*H_bitstring\):\s*([\d.]+)")
        # Estimators
        for m in re.finditer(r"(.+?(?:Estimate))\s*=\s*([\d.]+)\s*/\s*\d+\s*bit", non_iid_text):
            r["estimators"][m.group(1).strip()] = float(m.group(2))
        if r["estimators"]:
            lim = min(r["estimators"].items(), key=lambda x: x[1])
            r["limiting_estimator"] = f"{lim[0]} = {lim[1]:.6f}"

    return r

# ── Job runner ──────────────────────────────────────────────────────────────────

def _run_job(job_id: str):
    job = _db_one("SELECT * FROM nist_test_jobs WHERE id=?", (job_id,))
    if not job:
        return

    _db("UPDATE nist_test_jobs SET status='running', started_at=? WHERE id=?", (_now(), job_id))
    t0 = time.time()

    try:
        input_path = job["input_file_path"]
        test_type  = job["test_type"]        or "both"
        fmt_req    = job["format_requested"] or "auto"

        if not input_path or not os.path.exists(input_path):
            raise FileNotFoundError(f"Arquivo não encontrado: {input_path}")

        file_size = os.path.getsize(input_path)
        if file_size < NIST_MIN_BYTES:
            raise ValueError(
                f"Arquivo muito pequeno: {file_size:,} bytes. "
                f"NIST SP 800-90B requer >= {NIST_MIN_BYTES:,} amostras (≈1 MB para dados de 8 bits)."
            )

        sha_orig = _sha256(input_path)
        _db("UPDATE nist_test_jobs SET sha256_original=? WHERE id=?", (sha_orig, job_id))

        # CSV pre-conversion (script doesn't handle CSV natively)
        used_path    = input_path
        fmt_detected = fmt_req
        norm_path    = None

        if input_path.lower().endswith(".csv"):
            norm_path = input_path.replace(".csv", "_normalized.txt")
            count = _csv_to_u32txt(input_path, norm_path)
            log.info(f"[job {job_id[:8]}] CSV → {count} valores u32")
            used_path    = norm_path
            fmt_detected = "u32txt"
        elif fmt_req == "auto":
            fmt_detected = "raw" if input_path.lower().endswith(".bin") else "u32txt"

        sha_used = _sha256(used_path)

        # Determinado aqui, no único ponto em que format_detected é
        # conhecido com certeza -- persistido imediatamente, nunca
        # re-inferido depois pela API a partir do nome/timestamp do job.
        # Confirmado lendo qrng_nist90b.sh (item 2/3 da auditoria):
        #   raw    -> BITS_PER_SYMBOL=8, arquivo usado como está (passthrough)
        #   u32txt -> BITS_PER_SYMBOL=8, cada uint32 é serializado para 4
        #             bytes little-endian (struct.pack("<I", v)) antes da
        #             avaliação -- ou seja, mesmo para entrada "u32txt" o
        #             NIST avalia SÍMBOLOS DE 8 BITS (bytes), não palavras
        #             de 32 bits, e usa TODOS os 4 bytes de cada palavra
        #             (nenhuma lane é descartada).
        #   bits   -> BITS_PER_SYMBOL=1 (não usado pelo pipeline atual, que
        #             só produz raw/u32txt)
        if fmt_detected == "u32txt":
            symbol_width = 8
            normalization = "byte-decomposition-le-uint32"
            endianness = "little"
        elif fmt_detected == "raw":
            symbol_width = 8
            normalization = "raw-passthrough"
            endianness = None  # o script não reinterpreta limites de palavra em bytes crus
        elif fmt_detected == "bits":
            symbol_width = 1
            normalization = "bit-extraction"
            endianness = None
        else:
            symbol_width = None
            normalization = None
            endianness = None

        _db("""UPDATE nist_test_jobs SET
                normalized_file_path=?, format_detected=?, sha256_used=?,
                assessment_symbol_width=?, normalization_method=?, sample_endianness=?
               WHERE id=?""",
            (norm_path, fmt_detected, sha_used, symbol_width, normalization, endianness, job_id))

        # Run script — argv list (no shell=True)
        cmd = [NIST_SCRIPT, used_path, test_type, fmt_detected]
        log.info(f"[job {job_id[:8]}] Running: {' '.join(cmd)}")

        proc = subprocess.run(
            cmd,
            cwd=NIST_SUITE_DIR,
            capture_output=True,
            timeout=NIST_TIMEOUT_SEC,
        )

        stdout = proc.stdout.decode("utf-8", errors="replace")
        stderr = proc.stderr.decode("utf-8", errors="replace")

        # Locate result dir from script output
        m = re.search(r"Saída em:\s*(\S+)", stdout)
        result_dir = os.path.join(NIST_SUITE_DIR, m.group(1)) if m else None

        # Save stdout/stderr next to result dir or in a fallback
        if result_dir and os.path.isdir(result_dir):
            stdout_path = os.path.join(result_dir, "stdout.txt")
            stderr_path = os.path.join(result_dir, "stderr.txt")
        else:
            fallback = os.path.join(NIST_SUITE_DIR, f"job_{job_id[:8]}")
            Path(fallback).mkdir(exist_ok=True)
            stdout_path = os.path.join(fallback, "stdout.txt")
            stderr_path = os.path.join(fallback, "stderr.txt")
            result_dir  = fallback

        with open(stdout_path, "w") as f: f.write(stdout)
        with open(stderr_path, "w") as f: f.write(stderr)

        if proc.returncode != 0 and not stdout:
            raise RuntimeError(f"Script retornou {proc.returncode}: {stderr[:500]}")

        parsed   = _parse_output(stdout, test_type)
        duration = time.time() - t0

        def _b(v): return int(v) if v is not None else None

        _db("""UPDATE nist_test_jobs SET
                status='completed', finished_at=?, duration_seconds=?,
                stdout_path=?, stderr_path=?, result_dir=?,
                iid_passed=?, chi_square_passed=?, lrs_passed=?, permutation_passed=?,
                h_original_iid=?, h_bitstring_iid=?, h_min_iid=?,
                h_original_non_iid=?, h_bitstring_non_iid=?, h_min_non_iid=?,
                limiting_estimator=?, estimators_json=?
               WHERE id=?""",
            (
                _now(), duration, stdout_path, stderr_path, result_dir,
                _b(parsed["iid_passed"]), _b(parsed["chi_square_passed"]),
                _b(parsed["lrs_passed"]), _b(parsed["permutation_passed"]),
                parsed["h_original_iid"],    parsed["h_bitstring_iid"],    parsed["h_min_iid"],
                parsed["h_original_non_iid"], parsed["h_bitstring_non_iid"], parsed["h_min_non_iid"],
                parsed["limiting_estimator"], json.dumps(parsed["estimators"]),
                job_id,
            )
        )
        log.info(f"[job {job_id[:8]}] Done in {duration:.1f}s — iid_passed={parsed['iid_passed']}")

    except Exception as e:
        duration = time.time() - t0
        log.error(f"[job {job_id[:8]}] Failed: {e}")
        _db("""UPDATE nist_test_jobs SET status='failed', finished_at=?,
               duration_seconds=?, error_message=? WHERE id=?""",
            (_now(), duration, str(e)[:2000], job_id))

def _capture_time_iso(path: str) -> Optional[str]:
    """Melhor proxy disponível para 'quando a amostra foi produzida': o mtime
    do arquivo, lido UMA VEZ no momento da submissão e persistido -- nunca
    relido depois (o arquivo pode ser removido/rotacionado)."""
    try:
        return datetime.fromtimestamp(os.path.getmtime(path), tz=timezone.utc).isoformat()
    except OSError:
        return None

def _create_and_enqueue(
    trigger, input_path, orig_name, test_type, fmt,
    sample_origin: str,
    transport_format: Optional[str] = None,
    source_word_width: Optional[int] = None,
    sample_conditioned: Optional[bool] = None,
    captured_at: Optional[str] = None,
    job_id: Optional[str] = None,
) -> str:
    """
    sample_origin é obrigatório e deve ser decidido pelo CHAMADOR no momento
    da submissão -- nunca 'latest'/'periodic' genérico sem essa decisão
    explícita (item 2 da auditoria). transport_format/source_word_width/
    sample_conditioned só devem ser preenchidos quando a proveniência da
    amostra é REALMENTE conhecida (ex.: captura ao vivo controlada, ou
    upload com atestado explícito do operador) -- por padrão ficam
    desconhecidos (NULL), nunca assumidos como 'uint32-le' automaticamente.

    job_id pode ser fornecido pelo chamador quando o caminho do arquivo já
    foi construído a partir de um id gerado antes (ex.: /nist/upload, que
    precisa do id para nomear o diretório de destino antes de enfileirar).
    """
    if job_id is None:
        job_id = str(uuid.uuid4())
    if captured_at is None:
        captured_at = _capture_time_iso(input_path)
    _db("""INSERT INTO nist_test_jobs
               (id, created_at, status, trigger_type, input_file_path, original_filename,
                test_type, format_requested, sample_origin, transport_format,
                source_word_width, sample_conditioned, captured_at)
           VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (job_id, _now(), trigger, input_path, orig_name, test_type, fmt,
         sample_origin, transport_format, source_word_width,
         None if sample_conditioned is None else int(sample_conditioned),
         captured_at))
    _job_q.put(job_id)
    return job_id

# ── Periodic scheduler ──────────────────────────────────────────────────────────

_next_periodic: Optional[float] = None

def _schedule_periodic():
    global _next_periodic
    _next_periodic = time.time() + NIST_INTERVAL_SEC
    threading.Timer(NIST_INTERVAL_SEC, _run_periodic).start()

def _run_periodic():
    if not NIST_ENABLED:
        return
    if not NIST_LIVE_CAPTURE_PATH:
        # Item 2 da auditoria: sem captura ao vivo controlada configurada,
        # o scheduler NÃO procura genericamente pelo arquivo mais recente
        # na árvore compartilhada (isso é o que causava o job periódico
        # ficar preso reavaliando artefatos de auditoria manual antigos
        # como se fossem saúde atual). Fica inerte até NIST_LIVE_CAPTURE_PATH
        # ser configurado para um mecanismo real de captura -- não
        # implementado aqui, é uma lacuna de infraestrutura separada.
        log.info("[periodic] NIST_LIVE_CAPTURE_PATH não configurado -- sem amostra live recente, nenhum job criado.")
        _schedule_periodic()
        return

    if not os.path.exists(NIST_LIVE_CAPTURE_PATH):
        log.warning(f"[periodic] NIST_LIVE_CAPTURE_PATH configurado mas arquivo não existe: {NIST_LIVE_CAPTURE_PATH}")
        _schedule_periodic()
        return

    try:
        if os.path.getsize(NIST_LIVE_CAPTURE_PATH) < NIST_MIN_BYTES:
            log.warning("[periodic] Captura live configurada é menor que NIST_MIN_BYTES -- aguardando.")
            _schedule_periodic()
            return
    except OSError:
        _schedule_periodic()
        return

    log.info(f"[periodic] Testing captura live controlada: {NIST_LIVE_CAPTURE_PATH}")
    _create_and_enqueue(
        "periodic", NIST_LIVE_CAPTURE_PATH, os.path.basename(NIST_LIVE_CAPTURE_PATH),
        "both", "auto",
        sample_origin="periodic_live",
        transport_format="uint32-le",
        source_word_width=4,
        sample_conditioned=False,
    )
    _schedule_periodic()

if NIST_ENABLED:
    _schedule_periodic()

# ── FastAPI ─────────────────────────────────────────────────────────────────────

app = FastAPI(title="QRNG NIST SP 800-90B Service", version=SERVICE_VERSION)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def _request_id_and_version(request: Request, call_next):
    """Todo response carrega X-Request-ID (ecoa o do cliente ou gera um) e a
    identidade da versão do serviço — para rastrear cada requisição de upload e
    nunca confundir staging com produção."""
    rid = request.headers.get("x-request-id") or f"nist_{uuid.uuid4().hex[:16]}"
    request.state.request_id = rid
    try:
        response = await call_next(request)
    except Exception:
        resp = JSONResponse(status_code=500, content={"error": "INTERNAL", "request_id": rid})
        resp.headers["X-Request-ID"] = rid
        resp.headers["X-NIST-Service-Version"] = SERVICE_VERSION
        resp.headers["X-NIST-Service-Env"] = SERVICE_ENV
        return resp
    response.headers["X-Request-ID"] = rid
    response.headers["X-NIST-Service-Version"] = SERVICE_VERSION
    response.headers["X-NIST-Service-Env"] = SERVICE_ENV
    return response


# Confirmado no código-fonte de todo o pipeline físico (auditoria
# 2026-08-25, item 3): fifo.c lê o registrador AXI FIFO via mmap na Red
# Pitaya e grava exatamente 4 bytes little-endian (htole32) por amostra,
# sem processamento; server_api.py v1.1 declara STREAM_FORMAT="uint32-le",
# SAMPLE_WIDTH_BYTES=4, CONDITIONED=False. Confirmado empiricamente também:
# captura real de 1.000.000 amostras (2026-08-25T14:04:59Z, SHA-256
# 9c7ec2803b1b9507407cb105de85f2174d739f2da48f6f292ae8883d20b92495) mostra
# entropia ≈7,9996 bits em cada um dos 4 byte-lanes e nenhum dos 32 bits
# constante -- sem evidência de padding de ADC de menor resolução.
# ISTO DESCREVE SÓ O PIPELINE ATUAL -- nunca é atribuído a um job
# automaticamente; cada job carrega seus próprios metadados persistidos
# no momento da submissão (ver colunas transport_format etc.).
_UNKNOWN = "unknown"

def _meta_or_unknown(value):
    return _UNKNOWN if value is None else value

def _row(row) -> dict:
    if row is None:
        return None
    d = dict(row)
    if d.get("estimators_json"):
        try:    d["estimators"] = json.loads(d["estimators_json"])
        except: d["estimators"] = {}
    else:
        d["estimators"] = {}
    d.pop("estimators_json", None)
    for k in ["iid_passed", "chi_square_passed", "lrs_passed", "permutation_passed"]:
        if d.get(k) is not None:
            d[k] = bool(d[k])
    if d.get("sample_conditioned") is not None:
        d["sample_conditioned"] = bool(d["sample_conditioned"])

    # Item 2 da auditoria: metadados NUNCA inferidos aqui a partir de
    # nome/diretório/timestamp -- só o que foi persistido no momento da
    # submissão (_create_and_enqueue / _run_job). Jobs anteriores a esta
    # migração têm essas colunas NULL -- exibidos como "unknown" (nunca
    # adivinhados retroativamente).
    d["sample_origin"]           = _meta_or_unknown(d.get("sample_origin"))
    d["transport_format"]        = _meta_or_unknown(d.get("transport_format"))
    d["source_word_width"]       = d.get("source_word_width")       # int ou None (unknown)
    d["assessment_symbol_width"] = d.get("assessment_symbol_width") # int ou None (unknown)
    d["normalization_method"]    = _meta_or_unknown(d.get("normalization_method"))
    d["sample_endianness"]       = _meta_or_unknown(d.get("sample_endianness"))
    d["submitted_at"]            = d.get("created_at")  # alias semântico -- mesma coluna

    # Idade da amostra: usa captured_at persistido (nunca mtime relido ao
    # vivo -- o arquivo pode ter sido removido/rotacionado desde o job).
    d["sample_captured_age_seconds"] = None
    if d.get("captured_at"):
        try:
            captured = datetime.fromisoformat(d["captured_at"])
            d["sample_captured_age_seconds"] = round((datetime.now(timezone.utc) - captured).total_seconds(), 1)
        except ValueError:
            pass

    # "Stale" só faz sentido para jobs de monitoramento periódico ao vivo --
    # um upload histórico ou uma avaliação manual de um arquivo antigo não
    # "expira" depois de uma hora, porque nunca alegou ser amostra corrente.
    d["sample_file_is_stale"] = None
    if d.get("sample_origin") == "periodic_live" and d["sample_captured_age_seconds"] is not None:
        d["sample_file_is_stale"] = d["sample_captured_age_seconds"] > NIST_INTERVAL_SEC

    return d

@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "qrng-nist-api",
        "enabled": NIST_ENABLED,
        "version": SERVICE_VERSION,
        "commit": SERVICE_COMMIT,
        "build_date": SERVICE_BUILD_DATE,
        "environment": SERVICE_ENV,
        "upload_policy": {
            "max_bytes": NIST_UPLOAD_MAX_BYTES,
            "allowed_extensions": sorted(NIST_ALLOWED_UPLOAD_EXT),
            "streamed_to_temp_file": True,
            "full_file_in_memory": False,
        },
        "paths": {
            "db_path": DB_PATH,
            "data_dir": NIST_DATA_DIR,
            "upload_dir": NIST_UPLOAD_DIR,
            "suite_dir": NIST_SUITE_DIR,
            "script": NIST_SCRIPT,
        },
    }

@app.get("/nist/status")
def nist_status():
    last = _db_one("SELECT * FROM nist_test_jobs ORDER BY created_at DESC LIMIT 1")
    running = _db_one("SELECT id FROM nist_test_jobs WHERE status IN ('queued','running') LIMIT 1")
    return {
        "enabled":           NIST_ENABLED,
        "service": {
            "version":    SERVICE_VERSION,
            "commit":     SERVICE_COMMIT,
            "build_date": SERVICE_BUILD_DATE,
            "environment": SERVICE_ENV,
        },
        "suite_dir":         NIST_SUITE_DIR,
        "script":            NIST_SCRIPT,
        "data_dir":          NIST_DATA_DIR,
        "interval_seconds":  NIST_INTERVAL_SEC,
        "upload_max_bytes":  NIST_UPLOAD_MAX_BYTES,
        "allowed_upload_ext": sorted(NIST_ALLOWED_UPLOAD_EXT),
        "timeout_seconds":   NIST_TIMEOUT_SEC,
        "min_bytes":         NIST_MIN_BYTES,
        "queue_depth":       _job_q.qsize(),
        "has_active_job":    running is not None,
        "next_periodic":     datetime.fromtimestamp(_next_periodic, tz=timezone.utc).isoformat()
                             if _next_periodic else None,
        # Item 2 da auditoria: expõe explicitamente que não há monitoramento
        # periódico ao vivo real -- em vez do frontend inferir isso pela
        # ausência de jobs recentes.
        "live_capture_configured": NIST_LIVE_CAPTURE_PATH is not None,
        "live_capture_status": (
            "not_configured" if NIST_LIVE_CAPTURE_PATH is None
            else "configured"
        ),
        "last_job":          _row(last),
    }

@app.get("/nist/jobs")
def nist_jobs(limit: int = 50):
    rows = _db_all("SELECT * FROM nist_test_jobs ORDER BY created_at DESC LIMIT ?", (limit,))
    return {"jobs": [_row(r) for r in rows], "count": len(rows)}

@app.get("/nist/jobs/{job_id}")
def nist_job(job_id: str):
    row = _db_one("SELECT * FROM nist_test_jobs WHERE id=?", (job_id,))
    if not row:
        raise HTTPException(404, "Job não encontrado")
    return _row(row)

@app.get("/nist/jobs/{job_id}/log")
def nist_log(job_id: str):
    row = _db_one("SELECT stdout_path, stderr_path, status FROM nist_test_jobs WHERE id=?", (job_id,))
    if not row:
        raise HTTPException(404, "Job não encontrado")
    stdout = stderr = ""
    if row["stdout_path"] and os.path.exists(row["stdout_path"]):
        with open(row["stdout_path"], errors="replace") as f: stdout = f.read()
    if row["stderr_path"] and os.path.exists(row["stderr_path"]):
        with open(row["stderr_path"], errors="replace") as f: stderr = f.read()
    return {"stdout": stdout, "stderr": stderr, "status": row["status"]}

@app.post("/nist/run")
async def nist_run(
    test_type: str = Form("both"),
    format:    str = Form("auto"),
    source:    str = Form("latest"),
    filename:  Optional[str] = Form(None),
):
    if not NIST_ENABLED:
        raise HTTPException(503, "NIST desabilitado (NIST_ENABLED=false)")

    if source == "latest":
        file_path = _find_latest_data_file()
        if not file_path:
            raise HTTPException(404, "Nenhum arquivo adequado em NIST_DATA_DIR (mínimo 1 MB)")
        orig = os.path.basename(file_path)
    elif filename:
        safe = _safe_name(filename)
        file_path = os.path.join(NIST_DATA_DIR, safe)
        if not os.path.exists(file_path):
            raise HTTPException(404, f"Arquivo não encontrado: {safe}")
        orig = safe
    else:
        raise HTTPException(400, "source='latest' ou forneça filename")

    # Item 2 da auditoria: mesmo disparado manualmente por um humano, o
    # arquivo "mais recente" da árvore compartilhada não é uma captura ao
    # vivo verificada -- rotulado honestamente como avaliação histórica.
    # transport_format fica desconhecido (não assumido uint32-le) porque a
    # proveniência real do arquivo escolhido não é verificada aqui.
    job_id = _create_and_enqueue(
        "manual", file_path, orig, test_type, format,
        sample_origin="historical_assessment",
    )
    return {"job_id": job_id, "status": "queued", "file": os.path.basename(file_path)}

async def _stream_upload_to_file(upload: UploadFile, dst_path: str) -> tuple:
    """Escreve o corpo do upload em `dst_path` em blocos de NIST_UPLOAD_CHUNK,
    calculando SHA-256 no caminho. NUNCA materializa o arquivo inteiro em
    memória. Para assim que ultrapassa NIST_UPLOAD_MAX_BYTES.
    Retorna (bytes_gravados, sha256_hex_ou_None, excedeu_limite: bool)."""
    h = hashlib.sha256()
    total = 0
    exceeded = False
    with open(dst_path, "wb") as out:
        while True:
            chunk = await upload.read(NIST_UPLOAD_CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > NIST_UPLOAD_MAX_BYTES:
                exceeded = True
                break
            h.update(chunk)
            out.write(chunk)
    return total, (None if exceeded else h.hexdigest()), exceeded

@app.post("/nist/upload")
async def nist_upload(
    request:   Request,
    file:      UploadFile = File(...),
    test_type: str        = Form("both"),
    format:    str        = Form("auto"),
    # Item 2 da auditoria: atestação OPCIONAL do operador sobre a
    # proveniência da amostra. Nunca inferida automaticamente -- se não
    # informada, fica "unknown" (não assume uint32-le por padrão, mesmo
    # que esse seja o formato do pipeline atual). Use quando o upload é,
    # comprovadamente, uma captura do stream ao vivo atual (ex.: obtida via
    # GET /v1/raw), não um arquivo de proveniência desconhecida.
    attested_transport_format: Optional[str] = Form(None),
    attested_captured_at:      Optional[str] = Form(None),
    attested_conditioned:      Optional[bool] = Form(None),
):
    rid = getattr(request.state, "request_id", None) or f"nist_{uuid.uuid4().hex[:16]}"

    def _err(status, code, **extra):
        return JSONResponse(status_code=status,
                            content={"error": code, "request_id": rid, **extra})

    if not NIST_ENABLED:
        return _err(503, "NIST_DISABLED")

    orig = file.filename or "upload"
    ext  = Path(orig).suffix.lower()
    if ext not in NIST_ALLOWED_UPLOAD_EXT:
        return _err(400, "UNSUPPORTED_EXTENSION",
                    extension=ext or "(nenhuma)",
                    allowed=sorted(NIST_ALLOWED_UPLOAD_EXT))

    if attested_transport_format and attested_transport_format not in ("uint32-le",):
        return _err(400, "INVALID_ATTESTED_TRANSPORT_FORMAT",
                    detail="use 'uint32-le' ou omita")

    job_id  = str(uuid.uuid4())
    today   = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    job_dir = os.path.join(NIST_UPLOAD_DIR, today, f"job_{job_id[:8]}")
    Path(job_dir).mkdir(parents=True, exist_ok=True)
    safe_name = _safe_name(orig)

    # streaming para um .part temporário; só vira o arquivo final se passar tudo
    tmp_fd, tmp_path = tempfile.mkstemp(dir=job_dir, prefix="upload_", suffix=".part")
    os.close(tmp_fd)
    try:
        total, sha_original, exceeded = await _stream_upload_to_file(file, tmp_path)
    except Exception as e:  # noqa: BLE001
        _safe_unlink(tmp_path)
        log.error(f"[upload {rid}] erro de IO: {e}")
        return _err(500, "UPLOAD_IO_ERROR", detail=str(e)[:200])

    if exceeded:
        _safe_unlink(tmp_path)
        return _err(413, "UPLOAD_TOO_LARGE",
                    limit_bytes=NIST_UPLOAD_MAX_BYTES,
                    received_at_least_bytes=total)
    if total == 0:
        _safe_unlink(tmp_path)
        return _err(400, "EMPTY_FILE")

    ok, why = _validate_upload_content(tmp_path, ext)
    if not ok:
        _safe_unlink(tmp_path)
        return _err(400, "INVALID_CONTENT", detail=why)

    saved_path = os.path.join(job_dir, safe_name)
    try:
        os.replace(tmp_path, saved_path)
    except OSError as e:
        _safe_unlink(tmp_path)
        return _err(500, "UPLOAD_PERSIST_ERROR", detail=str(e)[:200])

    normalization = _normalization_for_ext(ext)
    # tamanho "normalizado": só o .csv muda de tamanho (re-serializado como
    # inteiros um-por-linha) e isso ocorre dentro de _run_job; aqui reportamos
    # o tamanho original como normalizado para .bin/.txt e "desconhecido até o
    # job" para .csv (nunca reprocessamos o arquivo inteiro no handler).
    size_normalized = total if ext in (".bin", ".txt") else None

    _create_and_enqueue(
        "upload", saved_path, orig, test_type, format,
        sample_origin="user_upload",
        transport_format=attested_transport_format,
        source_word_width=4 if attested_transport_format == "uint32-le" else None,
        sample_conditioned=attested_conditioned,
        captured_at=attested_captured_at,
        job_id=job_id,
    )

    return {
        "job_id":                 job_id,
        "request_id":             rid,
        "status":                 "queued",
        "provenance":             "user_upload",
        "attested":               bool(attested_transport_format),
        "original_filename":      orig,
        "stored_filename":        safe_name,
        "sha256_original":        sha_original,
        "size_original_bytes":    total,
        "size_normalized_bytes":  size_normalized,
        "assessment_unit":        "byte",
        "assessment_symbol_width_bits": 8,
        "sample_endianness":      "little" if attested_transport_format == "uint32-le" else "unknown",
        "sample_conditioned":     attested_conditioned,
        "normalization_method":   normalization,
        "upload_max_bytes":       NIST_UPLOAD_MAX_BYTES,
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host=os.getenv("NIST_BIND_ADDR", "127.0.0.1"),
        port=int(os.getenv("NIST_PORT", os.getenv("PORT", "8002"))),
        log_level="info",
    )
