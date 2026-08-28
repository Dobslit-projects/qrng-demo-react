# Proveniência por resposta validada contra o `server_api.py` REAL (fase item 4)

Instância **paralela e temporária** do `qrng-client-api` (modo `live`,
`QRNG_CONFIGURED_SOURCE=fpga`), **sem substituir a produção** e **sem abrir um
segundo consumidor sustentado da FPGA**:

1. leu `GET /health` do `server_api.py` real (via túnel `127.0.0.1:18001` →
   dobslit `:8001`) — **não consome bytes**;
2. capturou **UMA** resposta de `GET /random?bytes=256` (one-shot, 256 B);
3. construiu um **fixture de replay** dessa captura real (reproduz fielmente os
   headers reais — em particular a **ausência** de `X-QRNG-Captured-At`);
4. rodou a matriz contra o replay, dirigindo `online / degraded / exhausted /
   offline / hang(timeout)`.

## O que o `server_api.py` real fornece (capturado 2026-08-28)

```
GET /random  ->  Content-Type: application/octet-stream
                 X-QRNG-Captured-At   : AUSENTE
                 X-QRNG-Capture-Id    : AUSENTE
                 X-QRNG-Source-Status : AUSENTE
GET /health  ->  JSON com source_status / stream_format / conditioned
```

**Consequência direta:** contra o upstream real, **não há evidência de captura
por resposta**. Pelo default do item 4 (`allowLiveWithoutCaptureEvidence=false`),
`actual_origin` fica **`unknown`** e `live_verified` fica **`false`** em todas
as respostas de `/random` — o serviço **nunca alega `live` sem evidência**.

## Matriz — estado upstream × buffer × fallback × `actual_origin` × `live_verified`

| upstream mode | resposta | HTTP | `actual_origin` | `live_verified` | `source_health` | `buffer_health` | `fallback_used` | `captured_at` |
|---|---|---|---|---|---|---|---|---|
| online | `/v1/random` hex | 200 | **unknown** | false | healthy | healthy | false | null |
| degraded | `/v1/random` hex | 200 | **unknown** | false | **degraded** | healthy | false | null |
| exhausted | `/v1/random` hex(64) | 503 `INSUFFICIENT_ENTROPY` | **unknown** | false | healthy | **degraded** | false | null |
| offline | `/v1/random` hex | 502 `UPSTREAM_ERROR` | **unknown** | false | **failed** | unknown | false | null |
| hang (timeout 2 s) | `/v1/random` hex | 503 `QRNG_UNAVAILABLE` | **unknown** | false | healthy | unknown | false | null |
| online | `/v1/health` (autenticado) | 200 | **unknown** | false | healthy | unknown | false | null |
| online | `/v1/random` **raw** | 200 | **unknown** (header `X-QRNG-Provenance`) | `X-QRNG-Live-Verified: false` | `X-QRNG-Source-Health: healthy` | `X-QRNG-Buffer-Health: healthy` | `X-QRNG-Fallback-Used: false` | (header ausente) |

Smoke de formatos (online): `hex` → 32 chars, `base64` → 24 chars, `uint8` →
16 inteiros — todos com `actual_origin: unknown`.

## Regras obrigatórias — todas verificadas

| regra | resultado |
|---|---|
| não inventar `captured_at` | ✅ `null` em todas as linhas |
| `served_at` ≠ `captured_at` | ✅ `served_at` preenchido, `captured_at` `null`, `sample_age_ms` `null` |
| ausência de evidência ⇒ `live_verified=false` | ✅ `false` em todas as linhas |
| `actual_origin=unknown` sem evidência suficiente | ✅ `unknown` em todas as linhas |
| `fallback_used=true` impede `actual_origin=live` | ✅ (unit test `provenance.test.js` cenário 9; este client-api não tem fallback sintético, `fallback_used` é sempre `false` aqui) |
| configuração `live` não prova origem `live` | ✅ `instance_mode: "live"` mas `actual_origin: "unknown"` |
| JSON e headers concordam | ✅ raw: `X-QRNG-Provenance: unknown` == campo JSON `provenance` para o mesmo estado |
| header + JSON de erro (502/503) carregam `provenance_detail` | ✅ `INSUFFICIENT_ENTROPY` / `UPSTREAM_ERROR` / `QRNG_UNAVAILABLE` todos com `provenance_detail.actual_origin: "unknown"` |

## Implicação para o deploy

Para o `qrng-client-api` de produção reportar `actual_origin: "live"` é preciso
**uma** das duas coisas:

- **A)** `server_api.py` passa a emitir `X-QRNG-Captured-At` (e idealmente
  `X-QRNG-Capture-Id`) por resposta — então `actual_origin="live"` com
  `live_verified=true`; **ou**
- **B)** setar `LIVE_ALLOW_WITHOUT_CAPTURE_EVIDENCE=1` na instância de produção
  — então "upstream saudável servindo bytes" ⇒ `actual_origin="live"` com
  `live_verified=false` (sem prova de captura fresca).

**Recomendação:** ir com **B** no primeiro deploy (comportamento honesto:
`live` mas `live_verified=false`), e planejar **A** como melhoria do
`server_api.py` (fora do escopo desta rodada — mexe no caminho da FPGA).
Sem nenhuma das duas, produção reportaria `actual_origin="unknown"` em
`/random`, que é **correto mas conservador**.

Ver `qrng-client-api/lib/provenance.js` e `qrng-client-api/test/provenance.test.js`
(15 casos: os 9 exigidos + regra de evidência + `served_at`≠`captured_at` +
`/health` nos dois modos).
