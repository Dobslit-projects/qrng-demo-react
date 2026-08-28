# Evidência de captura e proveniência do upstream (fase item 9)

> **Projeto + patch + testes em STAGING apenas. NADA implantado.** O
> `server_api.py` de produção NÃO foi alterado. O patch exato está em
> `physical-layer/server_api.provenance_patch.py` (não aplicado).

## Problema

O `qrng-client-api` já sabe consumir evidência de captura por resposta
(`qrng-client-api/lib/provenance.js` → `resolveProvenance`): lê
`X-QRNG-Captured-At`, `X-QRNG-Capture-Id`, `X-QRNG-Source-Status`,
`X-QRNG-Buffer-Discontinuous` e só marca `actual_origin="live"` /
`live_verified=true` com timestamp de captura fresco e fonte saudável.

**O `server_api.py` de produção não emite nenhum desses headers.** Por isso, com
`LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE` desligado (estado do deploy 2026-08-28),
produção reporta honestamente `actual_origin="unknown"` / `live_verified=false`.
Item 9 = fechar essa lacuna **no upstream**, sem alterar o fluxo bruto.

## Opções avaliadas

| opção | prós | contras | veredito |
|---|---|---|---|
| **Metadata dentro do stream bruto** (prefixo/TLV por bloco) | 1 conexão | quebra o contrato `octet-stream` verbatim; todo consumidor teria de desframar; corrompe `/v1/raw` para uso direto; alinhamento uint32 destruído | **REJEITADO** — a instrução proíbe metadata no fluxo sem protocolo formal |
| **Endpoint de metadata separado** (`GET /v1/capture/<id>`) | fluxo intacto; consulta correlacionada por `capture_id` | 2 requisições; janela de corrida entre bytes e metadata | **COMPLEMENTAR** — bom para auditoria/replay, não para o caminho quente |
| **Sidecar** (processo publicando metadata num socket/arquivo) | desacopla | mais um processo para operar; sincronização | **REJEITADO** para agora — custo operacional |
| **Envelope versionado em HTTP headers** emitido pelo `server_api.py` | fluxo (corpo) 100% intacto; o client-api já consome; barato; versionável | headers não cobrem `/stream` (chunked) — aceitável, `/stream` não é caminho de proveniência | **ESCOLHIDO** |
| **Log correlacionado por capture_id** no `server_api.py` | trilha de auditoria retroativa | não verificável em tempo real pelo consumidor | **COMPLEMENTAR** — habilitar junto |

**Decisão:** envelope versionado em **headers HTTP** no `server_api.py`
(`/random`, `/v1/raw`, `/v1/uint32`) + endpoint de consulta
`GET /v1/capture/{capture_id}` + log JSONL correlacionado. O corpo continua
byte-idêntico.

## Envelope v1 (headers)

Emitido em `/random` (binário e hex), `/v1/raw`, `/v1/uint32`:

| header | valor | significado / verificação |
|---|---|---|
| `X-QRNG-Provenance-Version` | `1` | versão do envelope; consumidor rejeita o que não entende |
| `X-QRNG-Source-Instance` | `dobslit-qrng-ufpe-fpga` | qual fonte física (config); distingue instâncias |
| `X-QRNG-Source-Status` | `online` \| `degraded` \| `offline` | `rb.source_status()` no instante do `pop` |
| `X-QRNG-Captured-At` | ISO-8601 UTC | **`last_push_time`** — instante em que os bytes **mais recentes** entraram no ring buffer. **NÃO** é o instante da detecção do fóton; é a fronteira de frescor verificável sem tocar a FPGA. Documentado como tal. |
| `X-QRNG-Capture-Id` | `cap_<popcount>_<sha12>` | ID estável do bloco servido: `total_popped` no pop + 12 hex do SHA-256 do bloco |
| `X-QRNG-Sequence` | inteiro | `total_popped` **antes** deste pop = offset em bytes no fluxo já drenado do broker. Permite ao consumidor detectar buracos/reordenação entre chamadas. |
| `X-QRNG-Block-SHA256` | 64 hex | SHA-256 do corpo **exato** servido. O consumidor re-hasheia o corpo e compara → prova de integridade fim-a-fim broker→cliente. |
| `X-QRNG-Byte-Count` | inteiro | `len(body)` |
| `X-QRNG-Transport-Format` | `uint32-le` | idem `X-QRNG-Format` já existente |
| `X-QRNG-Buffer-Discontinuous` | `true` \| `false` | `true` se houve `drop-oldest` (o `total_pushed-total_popped-size` cresceu) desde o pop anterior → este bloco **não** é contíguo com o anterior |
| `X-QRNG-Conditioned` | `false` | já existente |

## Regra anti-má-classificação (invariante)

`resolveProvenance` já garante (testado):

1. `instance_mode ∈ {replay, fixture, historical}` ⇒ `actual_origin` **nunca**
   `live`, mesmo com todos os headers de evidência presentes. O modo da
   instância é **teto**, não piso.
2. `fallback_used=true` ⇒ `actual_origin="fallback"` (prevalece sobre tudo).
3. `X-QRNG-Captured-At` mais velho que `maxSampleAgeMs` (300 s) ⇒ não é `live`.
4. `X-QRNG-Source-Status ∈ {offline, failed}` ⇒ `source_health="failed"` ⇒ não é `live`.
5. `live_verified=true` **só** com `X-QRNG-Captured-At` presente e fresco.
6. **(novo, item 9)** `X-QRNG-Block-SHA256` presente e **divergente** do SHA-256
   do corpo recebido ⇒ `buffer_health` rebaixado, `capture_sha256_verified=false`,
   `actual_origin` não pode ser `live`.
7. **(novo, item 9)** `X-QRNG-Provenance-Version` ausente ou > conhecida ⇒ trata
   como "sem evidência" (degrada para `unknown`), nunca "assume live".

Assim, dados históricos servidos por uma instância `historical`, ou um fallback
pré-coletado, **não podem** ser rotulados `live` — nem por acidente de header.

## Endpoint de consulta (auditoria / replay)

`GET /v1/capture/{capture_id}` → `{capture_id, captured_at, sequence,
byte_count, sha256, source_status, source_instance, transport_format}` a partir
de um anel de registros em memória (últimos N capture_ids). **Sem** os bytes —
é só o registro. Correlaciona uma resposta antiga com sua metadata.

## Log correlacionado

`server_api.py` escreve `/var/log/qrng/captures.jsonl` (1 linha por resposta
servida): `{ts, capture_id, sequence, byte_count, sha256, source_status,
endpoint, client_ip}`. Rotação por `logrotate`. Nunca contém os bytes.

## O que está feito nesta rodada

- **`staging/fixture-upstream/app.py`**: `_capture_headers()` estendido com
  `X-QRNG-Provenance-Version`, `X-QRNG-Source-Instance`, `X-QRNG-Sequence`,
  `X-QRNG-Block-SHA256`, `X-QRNG-Byte-Count`. `GET /v1/capture/{id}` adicionado.
  (staging — não é produção.)
- **`qrng-client-api/lib/provenance.js`**: consome `X-QRNG-Provenance-Version`
  e `X-QRNG-Block-SHA256`; novo campo `provenance_version` e
  `capture_sha256` em `provenance_detail`; regra 6/7 acima. **Verificação do
  corpo vs `X-QRNG-Block-SHA256` fica em `server.js`** (onde o corpo é lido) —
  patch preparado em `physical-layer/server_api.provenance_patch.py` para o
  lado upstream e nas notas abaixo para o `server.js`; **não implantado**.
- **`qrng-client-api/test/provenance.test.js`**: casos novos (live c/ evidência,
  stale, replay-com-evidência ≠ live, versão desconhecida, sha divergente).
- **`physical-layer/server_api.provenance_patch.py`**: o `server_api.py` de
  produção com o envelope v1 — **arquivo de referência, NÃO aplicado**.

## O que falta (próxima autorização)

- Aplicar o patch ao `server_api.py` real numa janela (mexe no upstream de
  produção — fora do escopo desta rodada).
- `logrotate` + diretório `/var/log/qrng` no host da dobslit.
- Decidir se `X-QRNG-Captured-At` deve um dia refletir um timestamp **do RTL**
  (exigiria mudança na FPGA — bloqueado, ver `FPGA_INSPECTION.md`).
