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

Emitido em `/random` (binário e hex), `/v1/raw`, `/v1/uint32`, e replicado pelo
`qrng-client-api` (`setProvenanceHeaders`, raw **e** JSON):

| header | valor | significado / verificação |
|---|---|---|
| `X-QRNG-Provenance-Version` | `1` | versão do envelope; consumidor de versão desconhecida trata como "sem evidência" |
| `X-QRNG-Source-Instance` | `dobslit-qrng-ufpe-fpga` | qual fonte física (config); distingue instâncias |
| `X-QRNG-Source-Status` | `online` \| `degraded` \| `offline` | **eixo TRANSPORTE** — `rb.source_status()` no instante do `pop` |
| `X-QRNG-Entropy-Health` | `not_assessed` \| `healthy` \| `degraded` \| `failed` | **eixo ENTROPIA** (item 5) — RCT/APT. `not_assessed` por padrão (não rodam no caminho live). **NUNCA** inferido do transporte/buffer |
| `X-QRNG-Received-At` | ISO-8601 UTC | **item 4** — `last_push_time`: instante em que os bytes mais recentes **entraram no broker**. **NÃO** é a detecção do fóton — é a fronteira de frescor verificável sem tocar a FPGA |
| `X-QRNG-Captured-At` | ISO-8601 UTC **ou ausente** | carimbo de **captura física** da FPGA. **Hoje AUSENTE** — o `fifo.c` não produz timestamp (`FPGA_INSPECTION_RESULT.md`). Reservado; quando existir, é evidência mais forte que `Received-At` e habilita `live_verified=true` |
| `X-QRNG-Capture-Id` | `cap_<seq>_<sha12>` | ID estável do bloco servido |
| `X-QRNG-Sequence` | inteiro | **item 2/3** — `total_popped` **antes** deste pop = offset **monótono** em bytes no fluxo drenado do broker (sobrevive ao drop-oldest). Detecta buracos/reordenação entre chamadas |
| `X-QRNG-Block-SHA256` | 64 hex | SHA-256 do corpo **exato** servido — o consumidor re-hasheia e compara (integridade fim-a-fim broker→cliente) |
| `X-QRNG-Byte-Count` | inteiro | `len(body)` |
| `X-QRNG-Transport-Format` | `uint32-le` | idem `X-QRNG-Format` |
| `X-QRNG-Buffer-Discontinuous` | `true` \| `false` | **eixo BUFFER** — `true` se `X-QRNG-Discontinuities > 0` |
| `X-QRNG-Discontinuities` | inteiro | **item 3** — contagem acumulada de eventos `reconnect` + `realign` + `drop_oldest` do `WordAligner` |
| `X-QRNG-Realign-Bytes` | inteiro | **item 2/3** — bytes descartados no total para re-encaixar o grid uint32 após reconexões |
| `X-QRNG-Conditioned` | `false` | já existente |

## Itens 2/3/6 — alinhamento de palavra + descontinuidade

`physical-layer/transport_align.py` (`WordAligner`) + `test_transport_align.py`
(11 testes, no CI). Contexto: `fifo.c` escreve 4 bytes/palavra; numa **reconexão
do connector** os bytes em trânsito na rede se perdem — se a perda não for
múltiplo de 4, o agrupamento uint32 a jusante fica **permanentemente
desalinhado** (não há número de sequência da FPGA).

O `WordAligner`:
1. só entrega **palavras completas** (segura 0–3 bytes de cauda por conexão);
2. quando o connector sinaliza reconexão num `forwarded_offset` com resto ≠ 0,
   **descarta `(4 − resto) % 4` bytes** do próximo dado → re-encaixa o grid
   (best-effort, custa 0–3 bytes — **não recupera** os bytes perdidos na rede);
3. registra `Discontinuity{kind: reconnect|realign|drop_oldest, at_offset,
   bytes_dropped, ts}` num anel — exposto nos headers, **nunca** no stream.

Sinal do connector: **sideband JSONL** (`QRNG_CONNECTOR_EVENTS`, fora do stream)
emitido por `physical-layer/qrng-connector.staging.py`:
`{"event":"reconnect","forwarded_offset":N,"ts":...,"backoff_s":B}`. O
`server_api.py` (patch) drena esse sideband no produtor e chama
`aligner.note_reconnect(N)`.

**Desconexões determinísticas testadas** (item 6): corte após N bytes com
`N % 4 ∈ {0,1,2,3}`, perda de 0/2/4/6/8 bytes, reconexão → verifica: só
palavras completas; realinhamento descarta o número certo de bytes; o grid
volta a bater com a fonte lógica; cada evento vira `Discontinuity`; nada de
metadata entra no stream. `entropy_health` permanece `not_assessed` em todos.

## Item 5 — saúde em três eixos ortogonais

`qrng-client-api/lib/provenance.js` `resolveProvenance` passa a retornar:

| campo | fonte | valores |
|---|---|---|
| `transport_health` | `X-QRNG-Source-Status` + poller | `healthy` / `degraded` / `failed` / `unknown` |
| `buffer_health` | `X-QRNG-Discontinuities`, insufficient, sha-mismatch | `healthy` / `discontinuous` / `degraded` / `unknown` |
| `entropy_health` | `X-QRNG-Entropy-Health` (default `not_assessed`) | `not_assessed` / `healthy` / `degraded` / `failed` |
| `source_health` | **DEPRECATED** — alias de `transport_health` | — |

**Invariante:** `transport_health=healthy` + `buffer_health=healthy` **NÃO**
implica `entropy_health`. Um `entropy_health=failed` **derruba** `actual_origin`
de `live`; `not_assessed`/`degraded` **não** derrubam (`live` = proveniência,
não é validação de entropia). `provenance.test.js`: 23 → 32 (9 casos itens 4/5).

## Item 4 — Received-At (não "Captured-At")

`X-QRNG-Captured-At` era semanticamente errado (era `last_push_time`, não a
detecção física). Renomeado para **`X-QRNG-Received-At`**. `captured_at` fica
`null` até a FPGA carimbar de fato (exige RTL — bloqueado). `sample_age_ms` =
idade por `captured_at || received_at`. `live_verified=true` **só** com
`captured_at` (carimbo físico) presente e fresco.

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
