# -*- coding: utf-8 -*-
"""
Teste isolado (sem pytest) para as mudancas do item 8 da auditoria:
  - _find_latest_data_file() exclui diretorios audit*/characterization_*
  - _row() calcula sample_file_age_seconds / sample_file_is_stale / sample_unit

Faz stub de fastapi/uvicorn (nao instalados neste ambiente de teste) para
poder importar nist_service.py sem as dependencias pesadas -- o modulo so
usa decorators/classes triviais desses pacotes a nivel de import.
"""
import sys, os, types, tempfile, shutil, time, unittest

# ---- stub minimo de fastapi/uvicorn para permitir o import ----
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

# ---- ambiente isolado ANTES do import (efeitos colaterais no module-level) ----
TMPDIR = tempfile.mkdtemp(prefix="nist_test_")
os.environ["NIST_ENABLED"]   = "false"  # evita o scheduler _schedule_periodic() no import
os.environ["NIST_DATA_DIR"]  = os.path.join(TMPDIR, "data")
os.environ["NIST_DB_PATH"]   = os.path.join(TMPDIR, "nist.db")
os.makedirs(os.environ["NIST_DATA_DIR"], exist_ok=True)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import nist_service as ns  # noqa: E402


class TestFindLatestDataFile(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.mkdtemp(dir=os.environ["NIST_DATA_DIR"])
        # monkeypatch NIST_DATA_DIR para este teste especifico
        self._orig = ns.NIST_DATA_DIR
        ns.NIST_DATA_DIR = self.base

    def tearDown(self):
        ns.NIST_DATA_DIR = self._orig
        shutil.rmtree(self.base, ignore_errors=True)

    def _make_file(self, relpath, size=ns.NIST_MIN_BYTES, mtime_offset=0):
        path = os.path.join(self.base, relpath)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"\x00" * size)
        if mtime_offset:
            t = time.time() + mtime_offset
            os.utime(path, (t, t))
        return path

    def test_exclui_diretorio_audit(self):
        # audit52/ (artefato de auditoria manual, obsoleto) tem mtime mais
        # recente, mas deve ser ignorado.
        self._make_file("audit52/C01_digits_B01.bin", mtime_offset=100)
        fresh = self._make_file("live/fresh_capture.bin", mtime_offset=0)
        result = ns._find_latest_data_file()
        self.assertEqual(os.path.normpath(result), os.path.normpath(fresh))

    def test_exclui_diretorio_characterization(self):
        self._make_file("characterization_2026/run_new_05.bin", mtime_offset=100)
        fresh = self._make_file("live/fresh_capture.bin", mtime_offset=0)
        result = ns._find_latest_data_file()
        self.assertEqual(os.path.normpath(result), os.path.normpath(fresh))

    def test_sem_arquivo_adequado_retorna_none(self):
        self._make_file("audit9/only_stale.bin", mtime_offset=0)
        result = ns._find_latest_data_file()
        self.assertIsNone(result)

    def test_ainda_escolhe_o_mais_recente_entre_validos(self):
        self._make_file("live/older.bin", mtime_offset=-100)
        newer = self._make_file("live/newer.bin", mtime_offset=0)
        result = ns._find_latest_data_file()
        self.assertEqual(os.path.normpath(result), os.path.normpath(newer))


class TestRowSampleMetadata(unittest.TestCase):
    def test_sample_unit_sempre_presente_e_correto(self):
        d = ns._row({"id": "x", "estimators_json": None,
                      "iid_passed": None, "chi_square_passed": None,
                      "lrs_passed": None, "permutation_passed": None,
                      "input_file_path": None})
        self.assertEqual(d["sample_unit"]["format"], "uint32-le")
        self.assertEqual(d["sample_unit"]["width_bytes"], 4)
        self.assertFalse(d["sample_unit"]["conditioned"])

    def test_arquivo_inexistente_nao_calcula_idade(self):
        d = ns._row({"id": "x", "estimators_json": None,
                      "iid_passed": None, "chi_square_passed": None,
                      "lrs_passed": None, "permutation_passed": None,
                      "input_file_path": "/nao/existe/em/lugar/nenhum.bin"})
        self.assertIsNone(d["sample_file_age_seconds"])
        self.assertIsNone(d["sample_file_is_stale"])

    def test_arquivo_recem_criado_nao_e_stale(self):
        f = tempfile.NamedTemporaryFile(delete=False)
        f.write(b"x"); f.close()
        try:
            d = ns._row({"id": "x", "estimators_json": None,
                          "iid_passed": None, "chi_square_passed": None,
                          "lrs_passed": None, "permutation_passed": None,
                          "input_file_path": f.name})
            self.assertIsNotNone(d["sample_file_age_seconds"])
            self.assertLess(d["sample_file_age_seconds"], 5)
            self.assertFalse(d["sample_file_is_stale"])
        finally:
            os.unlink(f.name)

    def test_arquivo_mais_velho_que_o_intervalo_periodico_e_stale(self):
        f = tempfile.NamedTemporaryFile(delete=False)
        f.write(b"x"); f.close()
        old_time = time.time() - ns.NIST_INTERVAL_SEC - 3600  # 1h alem do intervalo
        os.utime(f.name, (old_time, old_time))
        try:
            d = ns._row({"id": "x", "estimators_json": None,
                          "iid_passed": None, "chi_square_passed": None,
                          "lrs_passed": None, "permutation_passed": None,
                          "input_file_path": f.name})
            self.assertTrue(d["sample_file_is_stale"])
        finally:
            os.unlink(f.name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
