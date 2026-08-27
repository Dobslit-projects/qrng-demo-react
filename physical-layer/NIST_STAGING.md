# Serviço NIST de staging (fase item 5)

Serviço NIST SP 800-90B **de staging**, isolado do produtivo, rodando a
**versão controlada** de `qrng-nist-api/nist_service.py` com as correções A–H
migradas (ver `qrng-api/NIST_SERVICE_BASELINE.md`). **A rodada para antes de
substituir o serviço NIST produtivo** (condição de parada).

## 1. Baseline preservado (pré-requisito, já feito)

| item | onde |
|---|---|
| Código realmente executado | `physical-layer/qrng-api/nist_service.py.RUNNING_BASELINE` (SHA-256 `e396675f…`, byte-idêntico ao processo vivo PID/porta `127.0.0.1:8002`) |
| Metadados do processo | `NIST_SERVICE_BASELINE.md` (path, size, mtime, user, venv, systemd unit, DB, env, ausência de string de versão) |
| Commit do baseline | `e558ed4` "baseline do componente realmente executado (item 2)" |
| Diff baseline × corrigido | `nist_service.py.diff-baseline-vs-65fb43b.txt` |
| Classificação funcional A–H | `NIST_SERVICE_BASELINE.md` §"8 functional differences" |

## 2. O que mudou na versão controlada nesta rodada

Além das correções A–H já classificadas, esta rodada adicionou (só à versão
controlada, **nada implantado**):

| # | mudança | motivo |
|---|---|---|
| I | `SERVICE_VERSION` / `SERVICE_COMMIT` / `SERVICE_BUILD_DATE` / `SERVICE_ENV` (env, default "unknown") expostos em `/health` e `/nist/status`; header `X-NIST-Service-Version` / `X-NIST-Service-Env` em toda resposta | nunca confundir staging com produção; um teste pode afirmar "estou falando com o commit X" |
| J | `/nist/upload` reescrito: **streaming** para arquivo temporário `.part` em blocos de 1 MiB (`_stream_upload_to_file`), SHA-256 calculado no caminho, **corpo nunca lido inteiro em memória**, para assim que passa do limite | política de upload do item 5 |
| K | limite explícito **128 MiB** (`NIST_UPLOAD_MAX_BYTES`, default do código); **413 estruturado** `{error:"UPLOAD_TOO_LARGE", limit_bytes, received_at_least_bytes, request_id}` | " |
| L | extensões restritas a `.bin/.txt/.csv` → `400 UNSUPPORTED_EXTENSION` com `allowed[]` | " |
| M | validação de conteúdo barata (`_validate_upload_content`): `.bin` aceita qualquer byte; `.txt/.csv` precisam decodificar como texto, sem NUL, com ao menos um dígito → `400 INVALID_CONTENT` | " |
| N | `400 EMPTY_FILE`; limpeza segura do `.part` em qualquer caminho de erro (`_safe_unlink`, nunca levanta) | " |
| O | resposta do upload traz `request_id`, `sha256_original`, `size_original_bytes`, `size_normalized_bytes`, `assessment_unit="byte"`, `assessment_symbol_width_bits=8`, `sample_endianness`, `sample_conditioned`, `normalization_method`, `provenance="user_upload"`, `attested` | rastreabilidade + unidade de avaliação explícita |
| P | `NIST_MIN_BYTES` virou configurável por env (default 1 000 000) | só para o staging poder testar com amostras pequenas |
| Q | middleware de `X-Request-ID` (ecoa o do cliente ou gera `nist_<hex>`) | rastrear cada upload |

`normalization_method` por extensão (confirmado lendo `qrng_nist90b.sh`):
`.bin → raw-passthrough`, `.txt/.csv → byte-decomposition-le-uint32`. Em todos
os casos o NIST avalia **símbolos de 8 bits (bytes)** — nenhuma lane descartada.

## 3. Arquitetura do staging

```
/qrng/nist/  --nginx staging-->  nist-staging:18092  (container)
                                   |
                                   +-- nist_service.py (versão controlada)
                                   +-- assessment = FAKE /opt/nist-fake/qrng_nist90b_fake.sh
                                   +-- DB     : volume kapua-staging-nist-data    -> /data/nist-staging.db
                                   +-- samples: volume kapua-staging-nist-samples -> /staging-data
```

- **Porta separada** `18092` (produção usa `127.0.0.1:8002` → `:18002`).
- **DB / data dir / upload dir isolados** — volumes dedicados, nunca
  `/home/dobslit/qrng-nist-api/nist.db` nem `/home/dobslit/qrng_data_nist`.
- **Fila** própria (in-memory `queue.Queue` do processo do container) — não
  compartilha a fila do processo produtivo.
- **Assessment FAKE**: `qrng_nist90b_fake.sh` emite saída canônica
  determinística no formato que `_parse_output` espera. A suíte SP 800-90B
  **real (C++) não está na imagem** — o staging exercita fila / persistência /
  histórico / lifecycle de job, não a matemática de entropia. `/health`
  reporta `environment: "staging"` e o script imprime "não é SP 800-90B real".
- **`environment` no `docker-compose.staging.yml`**: `NIST_UPLOAD_MAX_BYTES`
  reduzido a **1 MiB** só no staging para o teste "acima do limite" rodar
  rápido no CI (o default do código continua 128 MiB — asserção unitária
  `test_allowed_ext_e_limite_128mib`). `NIST_MIN_BYTES=256`.
- **Captura live**: `NIST_LIVE_CAPTURE_PATH` **não** configurado →
  `/nist/status` reporta `live_capture_configured: false`,
  `live_capture_status: "not_configured"`; nenhum job `periodic_live` é
  criado. Nada no staging aparece como `live`.

## 4. Identidade / versão (health)

`GET /qrng/nist/health` →
```json
{
  "status": "ok", "service": "qrng-nist-api", "enabled": true,
  "version": "1.1.0-staging-candidate",
  "commit": "<GITHUB_SHA ou git rev-parse HEAD>",
  "build_date": "<ISO8601 UTC>",
  "environment": "staging",
  "upload_policy": { "max_bytes": 1048576, "allowed_extensions": [".bin",".csv",".txt"],
                     "streamed_to_temp_file": true, "full_file_in_memory": false },
  "paths": { "db_path": "/data/nist-staging.db", "data_dir": "/staging-data", ... }
}
```
`commit` / `build_date` são injetados no build (`--build-arg
NIST_SERVICE_COMMIT` via `staging/up.sh` ou o job de CI). Sem injeção ficam
`"unknown"` — nunca adivinhados.

## 5. Testes (`e2e/staging/nist.spec.js`, BLOQUEANTE no CI)

Job `e2e-staging` do `.github/workflows/ci.yml`: sobe o compose (inclui
`nist-staging`), espera `/qrng/nist/health`, roda o Playwright. Cenários:

| # | cenário | asserção |
|---|---|---|
| 1 | identidade | `/health` tem version+commit, `environment=staging` (≠ production/live), `full_file_in_memory=false` |
| 2 | status | `/nist/status` tem `service.version`, `environment=staging`, `live_capture_configured=false` |
| 3 | abaixo do limite (.bin) | 200; `request_id`, `sha256_original` confere, `size_*`, `assessment_unit=byte`, `provenance=user_upload` (≠ live) |
| 4 | .txt de inteiros | 200; `normalization_method=byte-decomposition-le-uint32` |
| 5 | .csv | 200; `size_normalized_bytes=null` (não reprocessa no handler) |
| 6 | no limite exato | 200 |
| 7 | acima do limite | **413** `UPLOAD_TOO_LARGE` com `limit_bytes` + `received_at_least_bytes>limit` + `request_id` |
| 8 | 1 byte acima | 413 |
| 9 | extensão inválida (.pdf) | **400** `UNSUPPORTED_EXTENSION` com `allowed[]` |
| 10 | conteúdo inválido (.txt de NUL) | **400** `INVALID_CONTENT` |
| 11 | arquivo vazio | **400** `EMPTY_FILE` |
| 12 | atestação `uint32-le` | 200; `sample_endianness=little`, `attested=true` |
| 13 | atestação inválida | **400** `INVALID_ATTESTED_TRANSPORT_FORMAT` |
| 14 | `X-Request-ID` do cliente | ecoado no corpo e no header |
| 15 | job normal | poll → `completed`, `iid_passed=true`, `h_min_iid>0`, `sample_origin=user_upload` |
| 16 | falha do worker | `.bin` com marcador `FORCE_NIST_FAKE_FAILURE` → job `failed`, serviço segue de pé |
| 17 | fila + concorrência | 4 uploads `Promise.all` → 4 `job_id` distintos, todos em `/nist/jobs` |
| 18 | nomes iguais | dois `sample.bin` → `job_id` distintos, ambos persistidos |
| 19 | persistência + histórico | `/nist/jobs` lista com `sample_origin`; `404` para id desconhecido |
| 20 | replay/histórico nunca live | nenhum job `periodic_live`; `sample_file_is_stale` nunca `true`; `/status.last_job` idem |

**Marcados `test.fixme` (limitação de infra, não simular como aprovado):**
- **upload interrompido no meio** — `APIRequestContext` não expõe corte de
  conexão TCP. Mitigação verificada por outro caminho: `_stream_upload_to_file`
  + handler fazem `_safe_unlink` do `.part` em qualquer exceção (teste unitário).
- **timeout real do assessment** — exigiria um job > `NIST_TEST_TIMEOUT_SECONDS`
  (120 s no staging); o fake é instantâneo. `subprocess.run(timeout=)` já é
  código de produção.
- **restart de processo no meio da fila** — exigiria matar o container durante
  um job. Fila é in-memory: jobs `queued` **não sobrevivem** a restart; jobs já
  no DB mantêm o último status persistido. (comportamento aceito, documentado)

Testes unitários (`qrng-nist-api/test/test_nist_service.py`, job
`qrng-nist-api (testes Python)`): **23/23** — os 13 anteriores + 10 novos para
streaming / limite 128 MiB / validação de conteúdo / `_safe_unlink` /
`normalization_for_ext` / identidade de versão no `/health`.

## 6. Rodar

```bash
# raiz do repo, Docker disponível
bash staging/up.sh                       # sobe tudo, imprime MANIFESTO (inclui nist)
curl -s localhost:18080/qrng/nist/health | jq
curl -s -F file=@amostra.bin localhost:18080/qrng/nist/upload | jq
bash staging/down.sh                     # derruba + remove volumes
```

## 7. Antes de substituir o serviço NIST produtivo (PARADA)

Ainda **não autorizado**. Falta, conforme `NIST_MIGRATION_PLAN.md`:
1. migrar o banco real (`ALTER TABLE ADD COLUMN` idempotentes) sem apagar
   histórico;
2. rodar em paralelo numa porta de staging **contra a suíte SP 800-90B real**
   (não o fake) e comparar respostas lado a lado com o `:8002` produtivo;
3. testar contra os arquivos reais de `/home/dobslit/qrng_data_nist`;
4. janela de manutenção combinada para trocar o `ExecStart` do
   `qrng-nist-api.service`.

Próximo ponto de autorização: **executar o item 2 acima** (paralelo com suíte
real). Só depois, a troca do processo.
