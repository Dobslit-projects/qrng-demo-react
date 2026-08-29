# Capturas de tela do Guia do Usuário — proveniência

**Data da captura:** 2026-08-29.

## Como foram feitas
- **Bundle:** o de produção — `qrng-web:9e36a90`, arquivo `dist/assets/index-GEJGDRrN.js`, **byte-idêntico** ao servido em `https://bongo.dobslit.com/qrng/assets/index-GEJGDRrN.js` (gerado por `npm run build` no commit `51c1a2d`).
- **Renderização:** local (Chromium via Playwright, viewport 1440×940, `deviceScaleFactor: 2`), servido por `docs/_build/serve_local.mjs`.
- **Dados:** os **endpoints QRNG reais da produção**, que o nginx expõe sem cookie de sessão — `/qrng/api/*`, `/qrng/api-fpga/*`, `/qrng/nist/*`. As Visualizações Interativas chamam a rota autenticada `/qrng/v1/random`; o servidor local a reescreve para `/qrng/api/random` (mesma fonte, bytes reais de produção, **sem token**).
- **Swagger/ReDoc** (`24-`, `25-`): capturados diretamente de `https://bongo.dobslit.com/qrng/v1/docs/` e `/redoc` (rotas abertas).

## Por que não são do site hospedado diretamente
O SPA em `https://bongo.dobslit.com/qrng/` está atrás de um gate de sessão do host (`$cookie_bongo_session`) — sem esse cookie, tudo redireciona para login (302). Obter/usar esse cookie é uma ação de credencial fora do escopo. A renderização local do **mesmo bundle** com os **mesmos dados de produção** produz imagens fiéis à interface de produção, sem credencial alguma.

## Garantias
- Nenhuma imagem mostra token, senha, cookie ou cabeçalho de autenticação (a tela de "Desenvolvedor" aparece com os campos vazios).
- Em todas, a barra superior mostra `origem efetiva: desconhecida` — a produção **não** classifica as respostas como *live* nesta fase.
- Reprodutível: `node docs/_build/serve_local.mjs` (deixe rodando) + `node docs/_build/screenshots.mjs`.

## Índice
| Arquivo | Figura no guia | Conteúdo |
|---|---|---|
| `01-home-kapua.png` | 1 | Página inicial (Kapuã) |
| `02-config-fonte.png` | 2 | ⚙ Configurações — escolha da fonte |
| `03-barra-hardware.png` | 3 | Barra de Hardware (recorte do topo) |
| `23-desenvolvedor-login.png` | 4 | Desenvolvedor — tela de login |
| `24-swagger.png` | 5 | Swagger UI (produção) |
| `25-redoc.png` | 6 | ReDoc (produção) |
| `04-dados-raw.png` | 7 | Dados — Raw Binário |
| `05-dados-hex.png` | 8 | Dados — Hexadecimal |
| `06-dados-uint8.png` | 9 | Dados — Decimal / uint8 |
| `07-dados-faixa.png` | 10 | Dados — Faixa Personalizada |
| `08-dados-montecarlo.png` | 11 | Dados — Monte Carlo (floats) |
| `09-analise-scatter-hist-bits.png` | 12 | Análise Estatística — Scatter/Histograma/Bits/badges |
| `10-analise-stream.png` | 13 | Análise Estatística — Fluxo em tempo real |
| `16-app-montecarlo-pi.png` | 14 | Aplicações — π Monte Carlo |
| `11-viz-galaxia.png` | 15 | Visualizações Interativas — Galáxia (PRNG×QRNG) |
| `12-viz-mandala.png` | 16 | Visualizações Interativas — Mandala |
| `13-viz-cracker.png` | 17 | Visualizações Interativas — LCG Cracker |
| `14-viz-mtclone.png` | 18 | Visualizações Interativas — MT19937 Clone |
| `15-viz-sonificacao.png` | 19 | Visualizações Interativas — Sonificação |
| `17-app-sorteio.png` | 20 | Aplicações — Sorteio Auditável |
| `18-app-jogos.png` | 21 | Aplicações — Jogos (moeda/dado) |
| `19-app-randomwalk.png` | 22 | Aplicações — Random Walk |
| `20-app-otimizacao.png` | 23 | Aplicações — Otimização Estocástica |
| `22-nist.png` | 24 | Teste NIST |
| `21-app-chave-seed-desabilitada.png` | 25 | Aplicações — Chave/Seed desabilitadas |
