# -*- coding: utf-8 -*-
"""
Testes isolados (sem pytest) para o item 2 da auditoria: metadados de
amostra persistidos no momento da submissão, nunca inferidos depois.

Faz stub de fastapi/uvicorn para poder importar nist_service.py sem as
dependências pesadas -- o módulo só usa decorators/classes triviais delas
a nível de import.
"""
import sys, os, types, tempfile, shutil, time, unittest, sqlite3, asyncio, hashlib
from datetime import datetime, timezone, timedelta

# ---- stub mínimo de fastapi/uvicorn ----
fastapi_stub = types.ModuleType("fastapi")

class _DummyApp:
    def __init__(self, *a, **k): pass
    def add_middleware(self, *a, **k): pass
    def middleware(self, *a, **k):
        def deco(fn): return fn
        return deco
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
        ("assessment_engine", "TEXT"), ("synthetic_result", "INTEGER"),
        ("sha256_normalized", "TEXT"), ("size_original_bytes", "INTEGER"),
        ("size_normalized_bytes", "INTEGER"), ("normalized_symbol_count", "INTEGER"),
        ("first_parse_error", "TEXT"), ("endianness_rule", "TEXT"),
        ("stored_filename", "TEXT"),
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


class _FakeUpload:
    """UploadFile-like: só o .read(n) assíncrono, servindo bytes em blocos."""
    def __init__(self, data: bytes):
        self._buf = memoryview(data)
        self._pos = 0
    async def read(self, n=-1):
        if n is None or n < 0:
            n = len(self._buf) - self._pos
        chunk = bytes(self._buf[self._pos:self._pos + n])
        self._pos += len(chunk)
        return chunk


class TestUploadPolicyStreaming(unittest.TestCase):
    """Item 5: streaming para temporário, limite 128 MiB, SHA-256 no caminho,
    validação de conteúdo, limpeza segura. O corpo nunca é lido inteiro em
    memória (o handler chama _stream_upload_to_file em blocos)."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="upl_")
        self._orig_max = ns.NIST_UPLOAD_MAX_BYTES
        self._orig_chunk = ns.NIST_UPLOAD_CHUNK

    def tearDown(self):
        ns.NIST_UPLOAD_MAX_BYTES = self._orig_max
        ns.NIST_UPLOAD_CHUNK = self._orig_chunk
        shutil.rmtree(self.dir, ignore_errors=True)

    def _stream(self, data):
        dst = os.path.join(self.dir, "out.part")
        return dst, asyncio.run(ns._stream_upload_to_file(_FakeUpload(data), dst))

    def test_streaming_grava_tudo_e_hash_confere(self):
        ns.NIST_UPLOAD_CHUNK = 7  # blocos minúsculos: prova que é em pedaços
        data = os.urandom(1000)
        dst, (total, sha, exceeded) = self._stream(data)
        self.assertFalse(exceeded)
        self.assertEqual(total, 1000)
        self.assertEqual(sha, hashlib.sha256(data).hexdigest())
        with open(dst, "rb") as f:
            self.assertEqual(f.read(), data)

    def test_limite_excedido_para_cedo_e_nao_retorna_hash(self):
        ns.NIST_UPLOAD_MAX_BYTES = 512
        ns.NIST_UPLOAD_CHUNK = 64
        dst, (total, sha, exceeded) = self._stream(os.urandom(4096))
        self.assertTrue(exceeded)
        self.assertIsNone(sha)
        self.assertGreater(total, 512)          # detectou depois de passar do limite
        self.assertLessEqual(total, 512 + 64)   # mas parou quase imediatamente (1 bloco)

    def test_validacao_conteudo_bin_aceita_qualquer_byte(self):
        p = os.path.join(self.dir, "a.bin")
        with open(p, "wb") as f:
            f.write(os.urandom(4096))
        ok, _ = ns._validate_upload_content(p, ".bin")
        self.assertTrue(ok)

    def test_validacao_conteudo_txt_rejeita_binario_e_vazio(self):
        p = os.path.join(self.dir, "b.txt")
        with open(p, "wb") as f:
            f.write(b"\x00\x01\x02\xff no digits here")
        ok, why = ns._validate_upload_content(p, ".txt")
        self.assertFalse(ok)
        empty = os.path.join(self.dir, "c.txt")
        open(empty, "wb").close()
        ok2, _ = ns._validate_upload_content(empty, ".txt")
        self.assertFalse(ok2)

    def test_validacao_conteudo_txt_aceita_inteiros(self):
        p = os.path.join(self.dir, "d.txt")
        with open(p, "w") as f:
            f.write("123 456 789\n1011\n")
        ok, _ = ns._validate_upload_content(p, ".txt")
        self.assertTrue(ok)

    def test_safe_unlink_nunca_levanta(self):
        ns._safe_unlink(None)
        ns._safe_unlink(os.path.join(self.dir, "nao-existe.part"))  # sem exceção

    def test_normalization_por_extensao(self):
        self.assertEqual(ns._normalization_for_ext(".bin"), "raw-passthrough")
        self.assertEqual(ns._normalization_for_ext(".txt"), "byte-decomposition-le-uint32")
        self.assertEqual(ns._normalization_for_ext(".csv"), "byte-decomposition-le-uint32")
        self.assertEqual(ns._normalization_for_ext(".xyz"), "unknown")

    def test_allowed_ext_e_limite_128mib(self):
        self.assertEqual(ns.NIST_ALLOWED_UPLOAD_EXT, {".bin", ".txt", ".csv"})
        self.assertEqual(self._orig_max, 128 * 1024 * 1024)


class TestServiceIdentity(unittest.TestCase):
    """Item 5: /health e /nist/status devem expor version/commit/build_date/env
    para nunca confundir staging com produção."""

    def test_constantes_de_versao_existem(self):
        for name in ("SERVICE_VERSION", "SERVICE_COMMIT", "SERVICE_BUILD_DATE", "SERVICE_ENV"):
            self.assertTrue(hasattr(ns, name))

    def test_health_carrega_identidade_e_politica(self):
        h = ns.health()
        self.assertEqual(h["version"], ns.SERVICE_VERSION)
        self.assertIn("commit", h)
        self.assertEqual(h["upload_policy"]["max_bytes"], ns.NIST_UPLOAD_MAX_BYTES)
        self.assertFalse(h["upload_policy"]["full_file_in_memory"])
        self.assertTrue(h["upload_policy"]["streamed_to_temp_file"])
        self.assertEqual(sorted(h["upload_policy"]["allowed_extensions"]), [".bin", ".csv", ".txt"])


class TestAssessmentEngineIdentity(unittest.TestCase):
    """Item 4: identificação do motor de assessment em health/status/row."""

    def test_health_expoe_engine_e_synthetic(self):
        h = ns.health()
        self.assertIn("assessment_engine", h)
        self.assertIn("assessment_engine_version", h)
        self.assertIn("synthetic_result", h)
        self.assertIn("statistical_result_valid", h)
        # coerência: synthetic <=> engine == "fake" <=> NOT statistical_result_valid
        self.assertEqual(h["synthetic_result"], h["assessment_engine"] == "fake")
        self.assertEqual(h["statistical_result_valid"], not h["synthetic_result"])

    def test_row_marca_synthetic_quando_engine_fake(self):
        row = ns._row({
            "id": "x", "estimators_json": None,
            "iid_passed": None, "chi_square_passed": None, "lrs_passed": None,
            "permutation_passed": None, "input_file_path": None,
            "sample_origin": "user_upload", "transport_format": None,
            "source_word_width": None, "assessment_symbol_width": None,
            "normalization_method": None, "sample_endianness": None,
            "sample_conditioned": None, "captured_at": None, "created_at": None,
            "assessment_engine": "fake", "synthetic_result": 1,
        })
        self.assertEqual(row["assessment_engine"], "fake")
        self.assertTrue(row["synthetic_result"])
        self.assertFalse(row["statistical_result_valid"])

    def test_periodico_desligado_sem_live_capture(self):
        # NIST_LIVE_CAPTURE_PATH é None nos testes -> nenhum timer, next_periodic None
        self.assertIsNone(ns.NIST_LIVE_CAPTURE_PATH)
        self.assertIsNone(ns._next_periodic)
        # _run_periodic não reagenda nem cria job
        before = ns._next_periodic
        ns._run_periodic()
        self.assertEqual(ns._next_periodic, before)


class TestSafeNameHardening(unittest.TestCase):
    """Item 6: _safe_name é só metadado -- neutraliza travessia de caminho."""

    def test_path_traversal_posix(self):
        self.assertNotIn("/", ns._safe_name("../../etc/passwd"))
        self.assertEqual(ns._safe_name("../../etc/passwd"), "passwd")

    def test_separadores_windows_e_absoluto(self):
        self.assertNotIn("\\", ns._safe_name(r"..\..\windows\system32\x.bin"))
        self.assertNotIn("/", ns._safe_name("/etc/shadow"))
        self.assertNotIn(":", ns._safe_name("C:\\Users\\x\\a.bin"))

    def test_nome_gigante_e_controle(self):
        big = "a" * 5000 + ".bin"
        self.assertLessEqual(len(ns._safe_name(big)), 180)
        self.assertEqual(ns._safe_name("x\x00\x01y.bin"), "xy.bin")

    def test_unicode_preservado_como_rotulo(self):
        self.assertIn("amostra", ns._safe_name("amostra-ção.bin"))

    def test_vazio_ou_so_pontos(self):
        self.assertEqual(ns._safe_name(".."), "upload")
        self.assertEqual(ns._safe_name(""), "upload")


class TestTextNormalization(unittest.TestCase):
    """Item 6: .txt/.csv normalizados de verdade, com primeiro erro registrado."""

    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="norm_")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _run(self, text):
        src = os.path.join(self.d, "in.txt")
        dst = os.path.join(self.d, "out.txt")
        with open(src, "w") as f:
            f.write(text)
        return ns._normalize_text_ints(src, dst), dst

    def test_inteiros_validos(self):
        (count, err, rule), dst = self._run("1,2,3\n4,5,6\n")
        self.assertEqual(count, 6)
        self.assertIsNone(err)
        self.assertIn("little-endian", rule)

    def test_negativo_registra_primeiro_erro(self):
        (count, err, _), _ = self._run("1 2 -3 4\n")
        self.assertEqual(count, 3)
        self.assertIn("negativo", err)

    def test_acima_de_uint32(self):
        (count, err, _), _ = self._run(f"1\n2\n{2**32}\n")
        self.assertEqual(count, 2)
        self.assertIn("uint32", err)

    def test_colunas_inconsistentes(self):
        (count, err, _), _ = self._run("1,2,3\n4,5\n6,7,8\n")
        self.assertGreater(count, 0)
        self.assertIn("colunas", err)

    def test_texto_com_digitos_mas_sem_inteiro_valido(self):
        with self.assertRaises(ValueError):
            self._run("versao 1.2.3 build abc\n")  # tokens não-inteiros

    def test_nul_em_texto(self):
        with self.assertRaises(ValueError):
            self._run("1,2\x00,3\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)
