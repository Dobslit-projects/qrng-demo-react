#!/usr/bin/env python3
"""
QRNG NIST SP 800-90B Validation Service
Runs on Recife VM (dobslit@192.168.0.224) at port 8002
"""
import os, re, uuid, time, hashlib, json, struct, threading, logging, shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
import sqlite3
import subprocess
import queue as queue_module

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware

# ── Config ──────────────────────────────────────────────────────────────────────

NIST_ENABLED       = os.getenv("NIST_ENABLED",        "true").lower() == "true"
NIST_SUITE_DIR     = os.getenv("NIST_SUITE_DIR",      "/home/dobslit/SP800-90B_EntropyAssessment/cpp")
NIST_SCRIPT        = os.getenv("NIST_SCRIPT",         "/home/dobslit/SP800-90B_EntropyAssessment/cpp/qrng_nist90b.sh")
NIST_DATA_DIR      = os.getenv("NIST_DATA_DIR",       "/home/dobslit/qrng_data_nist")
NIST_INTERVAL_SEC  = int(os.getenv("NIST_TEST_INTERVAL_SECONDS", "300"))
NIST_TIMEOUT_SEC   = int(os.getenv("NIST_TEST_TIMEOUT_SECONDS",  "1800"))
NIST_MAX_UPLOAD_MB = int(os.getenv("NIST_MAX_UPLOAD_MB", "200"))
NIST_MIN_BYTES     = 1_000_000   # >= 1M samples required by NIST SP 800-90B
NIST_UPLOAD_DIR    = os.path.join(NIST_DATA_DIR, "uploads")
DB_PATH            = os.getenv("NIST_DB_PATH", "/home/dobslit/qrng-nist-api/nist.db")

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

def _find_latest_data_file() -> Optional[str]:
    candidates = []
    for ext in ["*.txt", "*.bin"]:
        for p in Path(NIST_DATA_DIR).rglob(ext):
            s = str(p)
            if any(x in s for x in ["uploads", "results_", ".log", ".lost", "sha256"]):
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
        _db("""UPDATE nist_test_jobs SET normalized_file_path=?, format_detected=?, sha256_used=?
               WHERE id=?""", (norm_path, fmt_detected, sha_used, job_id))

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

def _create_and_enqueue(trigger, input_path, orig_name, test_type, fmt) -> str:
    job_id = str(uuid.uuid4())
    _db("""INSERT INTO nist_test_jobs
               (id, created_at, status, trigger_type, input_file_path, original_filename, test_type, format_requested)
           VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)""",
        (job_id, _now(), trigger, input_path, orig_name, test_type, fmt))
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
    f = _find_latest_data_file()
    if f:
        log.info(f"[periodic] Testing: {f}")
        _create_and_enqueue("periodic", f, os.path.basename(f), "both", "auto")
    else:
        log.warning("[periodic] No suitable data file found (>= 1 MB)")
    _schedule_periodic()

if NIST_ENABLED:
    _schedule_periodic()

# ── FastAPI ─────────────────────────────────────────────────────────────────────

app = FastAPI(title="QRNG NIST SP 800-90B Service", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

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
    return d

@app.get("/health")
def health():
    return {"status": "ok", "service": "qrng-nist-api", "enabled": NIST_ENABLED}

@app.get("/nist/status")
def nist_status():
    last = _db_one("SELECT * FROM nist_test_jobs ORDER BY created_at DESC LIMIT 1")
    running = _db_one("SELECT id FROM nist_test_jobs WHERE status IN ('queued','running') LIMIT 1")
    return {
        "enabled":           NIST_ENABLED,
        "suite_dir":         NIST_SUITE_DIR,
        "script":            NIST_SCRIPT,
        "data_dir":          NIST_DATA_DIR,
        "interval_seconds":  NIST_INTERVAL_SEC,
        "timeout_seconds":   NIST_TIMEOUT_SEC,
        "min_bytes":         NIST_MIN_BYTES,
        "queue_depth":       _job_q.qsize(),
        "has_active_job":    running is not None,
        "next_periodic":     datetime.fromtimestamp(_next_periodic, tz=timezone.utc).isoformat()
                             if _next_periodic else None,
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

    job_id = _create_and_enqueue("manual", file_path, orig, test_type, format)
    return {"job_id": job_id, "status": "queued", "file": os.path.basename(file_path)}

@app.post("/nist/upload")
async def nist_upload(
    file:      UploadFile = File(...),
    test_type: str        = Form("both"),
    format:    str        = Form("auto"),
):
    if not NIST_ENABLED:
        raise HTTPException(503, "NIST desabilitado")

    orig = file.filename or "upload"
    ext  = Path(orig).suffix.lower()
    if ext not in [".bin", ".txt", ".csv"]:
        raise HTTPException(400, f"Extensão não suportada: {ext}. Use .bin, .txt ou .csv")

    content = await file.read()
    if len(content) > NIST_MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"Arquivo muito grande. Máximo: {NIST_MAX_UPLOAD_MB} MB")

    job_id  = str(uuid.uuid4())
    today   = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    job_dir = os.path.join(NIST_UPLOAD_DIR, today, f"job_{job_id[:8]}")
    Path(job_dir).mkdir(parents=True, exist_ok=True)

    safe_name  = _safe_name(orig)
    saved_path = os.path.join(job_dir, safe_name)
    with open(saved_path, "wb") as f: f.write(content)

    _db("""INSERT INTO nist_test_jobs
               (id, created_at, status, trigger_type, input_file_path, original_filename, test_type, format_requested)
           VALUES (?, ?, 'queued', 'upload', ?, ?, ?, ?)""",
        (job_id, _now(), saved_path, orig, test_type, format))
    _job_q.put(job_id)

    return {
        "job_id":            job_id,
        "status":            "queued",
        "original_filename": orig,
        "size_bytes":        len(content),
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8002, log_level="info")
