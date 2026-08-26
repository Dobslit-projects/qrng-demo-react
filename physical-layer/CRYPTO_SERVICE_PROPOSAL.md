# Proposta arquitetural: serviço criptográfico separado (item 11)

**Esta é uma proposta, não uma implementação.** Geração operacional de
chaves/seeds/nonces/tokens continua desabilitada (desde a rodada
anterior) e permanece desabilitada até esta proposta ser aprovada e
implementada — a aprovação de RCT/APT e da restart campaign NÃO reativa
isto automaticamente.

## Separação GetNoise vs. GetEntropy (nomenclatura SP 800-90B/90C)

```
                    ┌──────────────────────┐
  FPGA/FIFO ───────▶│ GetNoise (existente)  │──▶ /v1/random, /v1/public/random
                    │ dados brutos,         │    (JÁ EXISTE, sem mudança)
                    │ NÃO condicionados      │
                    └──────────┬───────────┘
                               │ (proposto, NÃO implementado)
                               ▼
                    ┌──────────────────────┐
                    │ Condicionador         │  algoritmo: A DEFINIR --
                    │ (ex.: SHA-256 ou       │  ver nota abaixo sobre
                    │  HMAC-based extractor) │  não introduzir silenciosamente
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ DRBG (ex.: CTR_DRBG    │  reseed periódico a partir
                    │  ou Hash_DRBG,         │  do condicionador
                    │  SP 800-90A)           │
                    └──────────┬───────────┘
                               │
                               ▼
                    GetEntropy (proposto) ──▶ /v1/crypto/key,
                                              /v1/crypto/seed
                                              (NÃO EXISTE ainda)
```

## Parâmetros a definir antes de qualquer implementação

| Parâmetro | Proposta inicial | Status |
|---|---|---|
| Endpoint de dados brutos | `/v1/random`, `/v1/public/random` (já existem) | JÁ EXISTE |
| Endpoint condicionado | `/v1/crypto/key`, `/v1/crypto/seed` | PROPOSTO, NÃO IMPLEMENTADO |
| Condicionador | A definir — candidatos: extrator baseado em SHA-256 (SP 800-90B seção 3.1.5.1.1) ou HMAC-DRBG direto sobre a entropia bruta | NÃO DECIDIDO |
| Entropia de entrada por chamada de reseed | Deve ser ≥ 2× a saída desejada em bits, usando a min-entropia CONSERVADORA medida (não a estimativa otimista da faixa IID) | A calcular quando a min-entropia final (pós restart campaign) existir |
| Tamanho de saída | Dependente do uso (256 bits para chave AES-256, etc.) | A definir por caso de uso |
| DRBG | CTR_DRBG ou Hash_DRBG (SP 800-90A) | NÃO DECIDIDO |
| Reseed | Periódico + sob demanda, nunca reaproveitando o mesmo material de entropia duas vezes | A implementar |
| Tratamento de falha | Se GetNoise reportar `FAILED` (ver `qrng_health_tests.py`), GetEntropy deve recusar servir imediatamente — nunca continuar servindo material derivado de uma fonte com saúde não confirmada | A implementar junto com a integração do health-test |
| Aderência SP 800-90 | Pretendida: 90B (fonte), 90A (DRBG), 90C (construção RBG) | Pretendida, não auditada por terceiros |

## Por que isto não foi implementado agora

O pedido é explícito: "Não adicione condicionamento apenas para fazer os
testes passarem. Qualquer condicionamento deve ser tratado como uma
mudança arquitetural separada e documentada" — e "produza uma proposta
separada... essa proposta deve ser aprovada antes da implementação". Esta
seção cumpre exatamente isso: documenta a decisão de design sem
implementá-la, para revisão humana explícita antes de qualquer código.
