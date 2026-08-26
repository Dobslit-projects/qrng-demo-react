# Plano de migração do serviço NIST real (item 9)

**Estado**: diff gerado, mudanças funcionais identificadas, testes
existentes reaproveitáveis. **Processo de produção NÃO substituído** —
esta rodada para aqui, conforme instruído, e aguarda autorização.

## Diff funcional (baseline `e396675f...` × commit `65fb43b`)

Arquivo completo: `qrng-api/nist_service.py.diff-baseline-vs-65fb43b.txt`
(309 linhas). Resumo das mudanças funcionais (não cosméticas):

| Área | Baseline (rodando, mtime 2026-06-29) | Commit 65fb43b (corrigido, nunca implantado) |
|---|---|---|
| `sample_origin` | Não existe como campo | `historical_assessment` \| `user_upload` \| `periodic_live` \| `restart_campaign`, persistido na submissão |
| `sample_unit` | `SAMPLE_UNIT_LIVE_STREAM` atribuído incondicionalmente a todo job | Removido; `transport_format`/`source_word_width`/`assessment_symbol_width`/`normalization_method`/`sample_endianness` derivados de `format_detected` e persistidos |
| `captured_at` | Não existe | Persistido no momento da submissão (mtime do arquivo no upload), nunca inferido depois |
| `sample_file_is_stale` | Calculado para QUALQUER job a partir do mtime atual do arquivo | Só calculado para `sample_origin="periodic_live"` |
| Agendador periódico | Busca genericamente "o arquivo mais recente" em `NIST_DATA_DIR`, incluindo diretórios de auditoria/caracterização | Exige `NIST_LIVE_CAPTURE_PATH` explícito; sem ele, não enfileira nada e reporta "sem amostra live recente" |
| `/nist/upload` | Sem campos de proveniência atestada | Aceita `attested_transport_format`/`attested_captured_at`/`attested_conditioned` opcionais |

Nenhuma mudança de schema é destrutiva — todas as colunas novas são
`ALTER TABLE ADD COLUMN`, idempotentes, e o serviço antigo continuaria
funcionando contra o banco migrado (colunas novas ficam `NULL`/ociosas).

## O que falta antes de trocar o processo real

1. **Migrar o banco real** (`/home/dobslit/qrng-nist-api/nist.db`) — rodar
   as mesmas migrações `ALTER TABLE ADD COLUMN` do commit corrigido contra
   ele, sem apagar histórico.
2. **Testar contra dados reais do host** — os 13 testes unitários já
   passam contra fixtures sintéticas (rodada anterior); faltam testes
   específicos contra os arquivos reais em `/home/dobslit/qrng_data_nist`
   (parsers `.bin`/`.txt`/`.csv`, se todos os três formatos realmente
   aparecem nesse diretório — não confirmado nesta rodada).
3. **Rodar em paralelo numa porta de staging** (ex.: 8003) contra o MESMO
   `NIST_DATA_DIR` em modo leitura, comparando respostas do serviço antigo
   (porta 8002 real) e do novo lado a lado, antes de qualquer substituição.
4. **Janela de manutenção combinada** — trocar `ExecStart` do
   `qrng-nist-api.service` para o código novo é uma parada/reinício do
   processo real; não foi feito aqui por não ter sido explicitamente
   autorizado para esta etapa ("pare antes de... substituir o serviço NIST
   produtivo").

## Comando de teste em paralelo proposto (não executado)

```bash
# Numa porta de staging (8003), NAO tocando o servico real (8002):
NIST_ENABLED=false NIST_DB_PATH=/tmp/nist_staging_compare.db \
  PORT=8003 python3 nist_service.py &
# Depois: repetir a mesma requisicao (mesmo arquivo) contra :8002 (real)
# e :8003 (novo), comparar campos de resposta manualmente.
```

Isto não foi executado nesta rodada por prudência (evitar qualquer
interação com o processo real sem uma janela combinada), mas o comando
está pronto.
