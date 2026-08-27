# Baseline do serviço NIST realmente executado (fase item 5)

Snapshot 2026-08-27 do `nist_service.py` **em produção** na dobslit VM
(`ubuntu-dobslit`, via túnel reverso `127.0.0.1:22222` no Bongo).

O código byte a byte já está versionado em
`physical-layer/qrng-api/nist_service.py.RUNNING_BASELINE` (commit `e558ed4`,
"baseline do componente realmente executado"). **Confirmado 2026-08-27:** a
cópia versionada é **byte-idêntica** ao arquivo vivo (`diff` = vazio). Este
documento adiciona os metadados de execução.

## Metadados de execução

| campo | valor |
|---|---|
| caminho | `/home/dobslit/qrng-nist-api/nist_service.py` |
| tamanho | **21090 bytes** |
| **SHA-256** | `e396675f1b2d9ae7eef6031f40c3c78aa6b6c6224664a62c7701c1e6e4015f2e` |
| mtime | **2026-06-29 22:37:09 UTC** (inalterado desde então — mais antigo que o commit `94e7dbd`) |
| processo | PID 177415, iniciado 2026-08-27 06:12:50 UTC (após reboot da VM) |
| usuário | `dobslit` (uid 1000) |
| interpretador | `/home/dobslit/qrng-api/venv/bin/python` → symlink → `/usr/bin/python3.14` (Python **3.14.4**) |
| argumentos | `python nist_service.py` (sem args) |
| cwd | `/home/dobslit/qrng-nist-api` |
| porta | `127.0.0.1:8002` → Bongo `127.0.0.1:18002` (túnel reverso) → nginx `/qrng/nist/` |
| mecanismo de init | `systemd` — unit `qrng-nist-api.service`, `Type=simple`, `Restart=always`, `RestartSec=10` |
| persistência | SQLite `nist.db` (5,3 MB) em `/home/dobslit/qrng-nist-api/nist.db` (+ `-wal`, `-shm`) |
| versão | **NENHUMA** — 1ª linha `#!/usr/bin/env python3`, sem `__version__`, sem string de versão, diretório não é repositório git |

### Configuração (Environment= no unit)

```
NIST_ENABLED=true
NIST_TEST_INTERVAL_SECONDS=3600
NIST_SUITE_DIR=/home/dobslit/SP800-90B_EntropyAssessment/cpp
NIST_SCRIPT=/home/dobslit/SP800-90B_EntropyAssessment/cpp/qrng_nist90b.sh
NIST_DATA_DIR=/home/dobslit/qrng_data_nist
NIST_DB_PATH=/home/dobslit/qrng-nist-api/nist.db
```

### Dependências

venv `/home/dobslit/qrng-api/venv` — **compartilhado** com `server_api.py`
(mesmo `ExecStart` de interpretador nos dois units). Python 3.14.4. FastAPI +
uvicorn (import no cabeçalho). O worker chama `qrng_nist90b.sh`, que por sua
vez roda os binários `ea_iid`/`ea_non_iid` de
`/home/dobslit/SP800-90B_EntropyAssessment/cpp` (compilados no host).
`pip freeze` do venv já capturado em `physical-layer/requirements-qrng-api.txt`
(commit `e558ed4`).

## Baseline (executado) × versão corrigida (`65fb43b` no repo)

- baseline `e396675f…` / 21090 B / 502 linhas
- corrigida `qrng-nist-api/nist_service.py` @ `65fb43b` (`5306052…` / 749 linhas)
- diff versionado: `nist_service.py.diff-baseline-vs-65fb43b.txt` (12 hunks)

**Endpoints:** os dois têm exatamente o mesmo conjunto — `/health`,
`/nist/status`, `/nist/jobs`, `/nist/jobs/{id}`, `/nist/jobs/{id}/log`,
`/nist/run`, `/nist/upload`. Nenhum endpoint foi removido ou renomeado.
Nenhum dos dois tem `__version__`.

### Classificação de TODAS as diferenças funcionais

| # | diferença | classe | efeito |
|---|---|---|---|
| A | `NIST_LIVE_CAPTURE_PATH` — gate no job periódico | **correção de proveniência** | baseline: o job periódico rodava SEMPRE, reavaliando arquivos estáticos de exercícios de auditoria manual e apresentando o resultado como "saúde atual do stream". corrigida: o job periódico só roda se `NIST_LIVE_CAPTURE_PATH` apontar para um mecanismo real de captura ao vivo; senão, não cria job e `/nist/status` expõe isso |
| B | 8 colunas novas em `nist_test_jobs` (`sample_origin`, `transport_format`, `source_word_width`, `assessment_symbol_width`, `normalization_method`, `sample_endianness`, `sample_conditioned`, `captured_at`) via `ALTER TABLE` idempotente | **aditivo** | proveniência **gravada no momento da submissão**, nunca re-inferida depois por nome/diretório/mtime |
| C | `EXCLUDED_PATTERNS` ganha `"audit"`, `"characterization_"` e passa a comparar em `.lower()` | **correção** | baseline reavaliava `audit52/C01_*.bin` (criado 2026-08-13, formato pré-uint32-LE, obsoleto) como se fosse a fonte atual |
| D | `_run_job` persiste `assessment_symbol_width` (8 p/ `raw`/`u32txt`, 1 p/ `bits`) e `normalization_method` (`raw-passthrough` / `byte-decomposition-le-uint32` / `bit-extraction`) no único ponto em que `format_detected` é certo | **aditivo** | rastreabilidade do que foi de fato passado a `ea_iid`/`ea_non_iid` |
| E | `_create_and_enqueue()` reescrita: `sample_origin` **obrigatório**, decidido pelo chamador (`periodic_live` \| `user_upload` \| `historical_assessment` \| `restart_campaign` \| NULL=unknown) | **mudança de contrato interno** | impossível criar job sem origem explícita |
| F | `/nist/status` expõe se o live-capture está configurado | **aditivo** | transparência |
| G | `/nist/upload` aceita `attested_transport_format` (deve ser `uint32-le` ou omitido → **400** se inválido); nunca assume `uint32-le` | **aditivo + validação** | proveniência do upload é atestada, não inferida |
| H | `_row()` devolve os campos de proveniência com fallback `"unknown"` | **aditivo** | job histórico sem proveniência → `unknown`, **nunca** `live` |

**Comportamento de avaliação estatística** (invocar `qrng_nist90b.sh`, parsear
`H_original`/`H_bitstring`, etc.) é **idêntico** nas duas versões. Todas as
mudanças são: correção de proveniência (A, C, E) + campos/rotas aditivos
(B, D, F, G, H).

### Próximo passo (staging)

Migrar A–H para uma cópia controlada, containerizada, em porta de staging
separada, com fila/DB/diretório **próprios** (não os de produção), e
`/health` expondo commit + versão. **Não substituir o processo produtivo.**
Ver `physical-layer/NIST_STAGING.md` (a criar).
