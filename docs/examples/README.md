# Exemplos — Kapuã QRNG

| Arquivo | O que é |
|---|---|
| `kapua_api_example.py` | Script mínimo (só biblioteca padrão) — health, `format=raw/hex/base64/uint8`, equivalência sobre amostra única, tratamento de 401/403/429/503. Roda sem token pelo caminho público. |
| `kapua_jupyter_example.ipynb` | Notebook introdutório — mesmo conteúdo do script, célula a célula, com `uint32-LE`, rejection sampling e proveniência. Placeholder de token. |
| `kapua_qrng_analises.ipynb` | **Bateria de análises estatísticas e de uso** sobre bytes reais da produção (χ², monobit, runs, DFT, autocorrelação, KS, compressão, bitmap; usos: `u=x/2³²`, Monte Carlo π, dado justo, passeio 2D, colisões de aniversário, semente/KDF). **Já vem executado** com gráficos e tabelas embutidos. |

## Token — como usar sem versioná-lo

Todos leem o token de uma variável de ambiente. **Nenhum arquivo aqui contém um token.**

```bash
export KAPUA_API_TOKEN="dobslit_qrng_live_…"     # o SEU token pessoal
python docs/examples/kapua_api_example.py         # (opcional; roda sem token no modo público)
jupyter lab docs/examples/kapua_qrng_analises.ipynb
```

- O token pessoal é emitido em **Portal → Desenvolvedor → Token** (`POST /v1/tokens`) e tem o formato `dobslit_qrng_live_<hex>`.
- **Nunca** cole o token numa célula, num commit, num log ou num print. Se ele vazar, **rotacione** imediatamente (`POST /v1/me/token/rotate` ou o botão "Regenerar" no portal).
- O token **autentica e mede a cota** — não altera, não condiciona nem "melhora" os bytes.

## Como `kapua_qrng_analises.ipynb` foi gerado / re-executar

Construído e executado por `docs/_build/build_qrng_notebook.py` (constrói o `.ipynb` a
partir de pares markdown/código; com `--run` executa as células **neste processo**, sem
kernel/zmq, e embute stdout + figuras). Re-executar:

```bash
KAPUA_API_TOKEN=… python docs/_build/build_qrng_notebook.py --run
```

Ou abra o `.ipynb` num Jupyter com `KAPUA_API_TOKEN` no ambiente e rode tudo.

## Ressalva sobre os resultados

Os testes do notebook são **empíricos, sobre a amostra baixada no momento da execução**.
Nesta fonte, hoje, o **monobit** costuma acusar um **viés de 1º momento pequeno mas
mensurável** (proporção de 1s ≈ 0,499) — coerente com a caracterização já registrada
(min-entropia estimada abaixo de 8 bits/byte, trilha não-IID) e a razão de a fonte estar
**em validação** e de a geração criptográfica estar **desabilitada**. Os testes de
estrutura (runs, espectral, autocorrelação, KS, compressão) passam de forma consistente.
Avaliação séria de entropia: página **"Teste NIST"** do portal (SP 800-90B). Ver
`docs/GUIA_DO_USUARIO_KAPUA.md`.
