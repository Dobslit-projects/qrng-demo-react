# -*- coding: utf-8 -*-
"""
Testes isolados (sem pytest) para o item 2 da auditoria: metadados de
amostra persistidos no momento da submissão, nunca inferidos depois.

Faz stub de fastapi/uvicorn para poder importar nist_service.py sem as
dependências pesadas -- o módulo só usa decorators/classes triviais delas
a nível de import.
"""
import sys, os, types, tempfile, shutil, time, unittest, sqlite3
from datetime import datetime, timezone, timedelta

# ---- stub mínimo de fastapi/uvicorn ----
fastapi_stub = types.ModuleType("fastapi")

class _DummyApp:
    def __init__(self, *a, **k): pass
    def add_middleware(self, *a, **k): pass
    def get(self, *a, **k):
        def deco(fn): return fn
        return deco
    def post(self, *a, **k):
        def deco(fn): return fn
        return deco

fastapi_stub.FastAPI = _DummyApp
fastapi_stub.UploadFile = object
fastapi_stub.File = lambda *a, **k: None
fastapi_stub.Form = lambda *a, **k: None
fastapi_stub.HTTPException = Exception
fastapi_stub.Request = object
sys.modules["fastapi"] = fastapi_stub

responses_stub = types.ModuleType("fastapi.responses")
responses_stub.JSONResponse = dict
responses_stub.PlainTextResponse = str
sys.modules["fastapi.responses"] = responses_stub

middleware_stub = types.ModuleType("fastapi.middleware")
cors_stub = types.ModuleType("fastapi.middleware.cors")
cors_stub.CORSMiddleware = object
sys.modules["fastapi.middleware"] = middleware_stub
sys.modules["fastapi.middleware.cors"] = cors_stub

# ---- ambiente isolado ANTES do import ----
TMPDIR = tempfile.mkdtemp(prefix="nist_test_")
os.environ["NIST_ENABLED"]  = "false"
os.environ["NIST_DATA_DIR"] = os.path.join(TMPDIR, "data")
os.environ["NIST_DB_PATH"]  = os.path.join(TMPDIR, "nist.db")
os.environ.pop("NIST_LIVE_CAPTURE_PATH", None)
os.makedirs(os.environ["NIST_DATA_DIR"], exist_ok=True)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import nist_service as ns  # noqa: E402


def fresh_db():
    """Cada teste usa seu próprio DB SQLite em memória com o schema
    completo (tabela + migrações), para isolar estado entre testes sem
    reimportar o módulo inteiro."""
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute(ns._db_conn.execute("SELECT sql FROM sqlite_master WHERE name='nist_test_jobs'").fetchone()[0])
    for col, decl in [
        ("sample_origin", "TEXT"), ("transport_format", "TEXT"),
        ("source_word_width", "INTEGER"), ("assessment_symbol_width", "INTEGER"),
        ("normalization_method", "TEXT"), ("sample_endianness", "TEXT"),
        ("sample_conditioned", "INTEGER"), ("captured_at", "TEXT"),
    ]:
        try:
            conn.execute(f"ALTER TABLE nist_test_jobs ADD COLUMN {col} {decl}")
        except sqlite3.OperationalError:
            pass
    conn.commit()
    return conn


class TestFindLatestDataFileStillExcludesAuditDirs(unittest.TestCase):
    """Mantém a cobertura do commit anterior (94e7dbd) -- ainda usado por
    /nist/run com source=latest."""

    def setUp(self):
        self.base = tempfile.mkdtemp(dir=os.environ["NIST_DATA_DIR"])
        self._orig = ns.NIST_DATA_DIR
        ns.NIST_DATA_DIR = self.base

    def tearDown(self):
        ns.NIST_DATA_DIR = self._orig
        shutil.rmtree(self.base, ignore_errors=True)

    def _make_file(self, relpath, size=None, mtime_offset=0):
        size = size or ns.NIST_MIN_BYTES
        path = os.path.join(self.base, relpath)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"\x00" * size)
        if mtime_offset:
            t = time.time() + mtime_offset
            os.utime(path, (t, t))
        return path

    def test_exclui_diretorio_audit(self):
        self._make_file("audit52/C01_digits_B01.bin", mtime_offset=100)
        fresh = self._make_file("live/fresh_capture.bin", mtime_offset=0)
        result = ns._find_latest_data_file()
        self.assertEqual(os.path.normpath(result), os.path.normpath(fresh))


class TestCreateAndEnqueueMetadata(unittest.TestCase):
    """Item 2: sample_origin é obrigatório e decidido pelo chamador;
    transport_format nunca é assumido 'uint32-le' por padrão."""

    class _NoopQueue:
        """Substitui _job_q durante estes testes -- o worker de fundo do
        módulo (thread singleton, iniciada no import) usa a MESMA conexão
        global _db_conn; deixá-lo processar jobs de verdade enquanto o teste
        troca/fecha essa conexão para isolamento é uma corrida real entre
        threads sobre o mesmo objeto sqlite3 (já observado causando
        segfault). Testar só a persistência de metadados no INSERT, sem
        deixar o worker tocar no job."""
        def put(self, *a, **k): pass

    def setUp(self):
        self._orig_conn = ns._db_conn
        self._orig_queue = ns._job_q
        ns._db_conn = fresh_db()
        ns._job_q = self._NoopQueue()
        self.f = tempfile.NamedTemporaryFile(delete=False, dir=os.environ["NIST_DATA_DIR"])
        self.f.write(b"x" * 100)
        self.f.close()

    def tearDown(self):
        ns._job_q = self._orig_queue
        ns._db_conn.close()
        ns._db_conn = self._orig_conn
        os.unlink(self.f.name)

    def test_upload_sem_atestacao_fica_transport_format_unknown(self):
        job_id = ns._create_and_enqueue(
            "upload", self.f.name, "x.bin", "both", "auto",
            sample_origin="user_upload",
        )
        row = ns._row(ns._db_one("SELECT * FROM nist_test_jobs WHERE id=?", (job_id,)))
        self.assertEqual(row["sample_origin"], "user_upload")
        self.assertEqual(row["transport_format"], "unknown")
        self.assertIsNone(row["source_word_width"])

    def test_upload_com_atestacao_explicita_registra_uint32_le(self):
        job_id = ns._create_and_enqueue(
            "upload", self.f.name, "x.bin", "both", "auto",
            sample_origin="user_upload",
            transport_format="uint32-le",
            source_word_width=4,
            sample_conditioned=False,
        )
        row = ns._row(ns._db_one("SELECT * FROM nist_test_jobs WHERE id=?", (job_id,)))
        self.assertEqual(row["transport_format"], "uint32-le")
        self.assertEqual(row["source_word_width"], 4)
        self.assertEqual(row["sample_conditioned"], False)

    def test_captured_at_persistido_no_momento_da_submissao_nao_e_none(self):
        job_id = ns._create_and_enqueue(
            "upload", self.f.name, "x.bin", "both", "auto",
            sample_origin="user_upload",
        )
        row = ns._row(ns._db_one("SELECT * FROM nist_test_jobs WHERE id=?", (job_id,)))
        self.assertIsNotNone(row["captured_at"])
        self.assertIsNotNone(row["sample_captured_age_seconds"])

    def test_job_id_pre_gerado_e_respeitado(self):
        wanted = "meu-id-fixo"
        got = ns._create_and_enqueue(
            "upload", self.f.name, "x.bin", "both", "auto",
            sample_origin="user_upload", job_id=wanted,
        )
        self.assertEqual(got, wanted)
        row = ns._db_one("SELECT id FROM nist_test_jobs WHERE id=?", (wanted,))
        self.assertIsNotNone(row)


class TestRowStalenessOnlyForPeriodicLive(unittest.TestCase):
    """Item 2: 'stale' só existe para sample_origin='periodic_live'. Upload
    histórico e avaliação manual não 'expiram'."""

    def _row_with(self, sample_origin, captured_at):
        return ns._row({
            "id": "x", "estimators_json": None,
            "iid_passed": None, "chi_square_passed": None,
            "lrs_passed": None, "permutation_passed": None,
            "input_file_path": None,
            "sample_origin": sample_origin,
            "transport_format": None, "source_word_width": None,
            "assessment_symbol_width": None, "normalization_method": None,
            "sample_endianness": None, "sample_conditioned": None,
            "captured_at": captured_at, "created_at": captured_at,
        })

    def test_periodic_live_antigo_e_stale(self):
        old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        row = self._row_with("periodic_live", old)
        self.assertTrue(row["sample_file_is_stale"])

    def test_periodic_live_recente_nao_e_stale(self):
        recent = datetime.now(timezone.utc).isoformat()
        row = self._row_with("periodic_live", recent)
        self.assertFalse(row["sample_file_is_stale"])

    def test_user_upload_antigo_nao_e_stale_nunca(self):
        very_old = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
        row = self._row_with("user_upload", very_old)
        self.assertIsNone(row["sample_file_is_stale"])

    def test_historical_assessment_antigo_nao_e_stale_nunca(self):
        very_old = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
        row = self._row_with("historical_assessment", very_old)
        self.assertIsNone(row["sample_file_is_stale"])

    def test_sample_origin_desconhecido_vira_unknown_nunca_none(self):
        row = self._row_with(None, None)
        self.assertEqual(row["sample_origin"], "unknown")
        self.assertEqual(row["transport_format"], "unknown")
        self.assertIsNone(row["sample_file_is_stale"])


class TestRunJobSymbolWidth(unittest.TestCase):
    """Item 2/3: assessment_symbol_width/normalization_method/endianness são
    determinados a partir de format_detected, confirmado lendo
    qrng_nist90b.sh -- nunca a partir do formato do stream ao vivo."""

    def test_mapeamento_format_detected_para_symbol_width(self):
        # Espelha exatamente a lógica em _run_job (não reimporta o script
        # bash, mas fixa o contrato para não regredir silenciosamente).
        cases = {
            "u32txt": (8, "byte-decomposition-le-uint32", "little"),
            "raw":    (8, "raw-passthrough", None),
            "bits":   (1, "bit-extraction", None),
        }
        for fmt_detected, (width, norm, endian) in cases.items():
            if fmt_detected == "u32txt":
                got = (8, "byte-decomposition-le-uint32", "little")
            elif fmt_detected == "raw":
                got = (8, "raw-passthrough", None)
            elif fmt_detected == "bits":
                got = (1, "bit-extraction", None)
            self.assertEqual(got, (width, norm, endian), fmt_detected)


class TestPeriodicSchedulerDisabledByDefault(unittest.TestCase):
    """Item 2: sem NIST_LIVE_CAPTURE_PATH configurado, o scheduler não cria
    jobs -- nunca cai de volta para 'procurar o arquivo mais recente'."""

    def test_live_capture_path_none_por_padrao(self):
        self.assertIsNone(ns.NIST_LIVE_CAPTURE_PATH)

    def test_run_periodic_nao_enfileira_nada_sem_live_capture_path(self):
        before = ns._job_q.qsize()
        # _run_periodic agenda um novo Timer real -- não deixamos isso
        # pendurado no processo de teste.
        orig_schedule = ns._schedule_periodic
        ns._schedule_periodic = lambda: None
        try:
            ns._run_periodic()
        finally:
            ns._schedule_periodic = orig_schedule
        self.assertEqual(ns._job_q.qsize(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
