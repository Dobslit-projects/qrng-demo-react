# DOBSLIT — PRNG vs QRNG

Demo interativa que compara geradores de numeros pseudo-aleatorios (PRNG) com numeros quanticos reais (QRNG) produzidos por hardware Red Pitaya.

## Stack

- **React 19** + **Vite 7.3** (SPA, inline styles, zero CSS frameworks)
- Canvas 2D para todas as visualizacoes em tempo real
- API REST para comunicacao com o hardware QRNG

## Funcionalidades

### Analise

Scatter plot, distribuicao e bit stream lado a lado (PRNG vs QRNG) com metricas estatisticas: entropia Shannon, ratio 1s, longest run.

### Stream Quantico

Visualizacao em tempo real do fluxo de bytes quanticos gerados pelo hardware.

### Jogos / Visualizacoes

Demos interativas que tornam visivel a diferenca entre PRNG e QRNG:

| Modo | Descricao |
|------|-----------|
| **Fluxo** | Campo de fluxo de particulas |
| **Caminhada** | Random walk com trilhas e glow |
| **Lava** | Oscilacao organica estilo lava lamp |
| **Galaxia** | Espiral com 900 estrelas, rotacao continua |
| **Mandala** | Simetria 8-fold com cobertura % em tempo real e sparkline |
| **Matrix** | Chuva de caracteres estilo Matrix |

Cada modo roda PRNG (vermelho) e QRNG (azul) lado a lado com badges de testes estatisticos (Monobit, Runs, Chi², Entropia).

**Mandala** inclui:
- Grid de cobertura 100x100 com calculo circular da area alcancavel
- Overlay com porcentagem de cobertura e grafico sparkline de serie temporal
- Halo sutil na borda da area alcancavel
- Stain layer que mostra o historico de preenchimento

### Chaves

Gerador de seeds criptograficas a partir de dados quanticos.

### Download

Exportacao de dados QRNG brutos.

## Arquitetura

```
src/
  App.jsx                    # Roteamento por tabs
  contexts/AppContext.jsx     # Estado global (health, latencia, fonte QRNG)
  qrngApi.js                 # Comunicacao com API do hardware
  prng.js                    # PRNG com quantizacao em 8 niveis
  theme.js                   # Paleta e tipografia
  components/
    layout/                  # Header, Footer, StatusBar, SectionNav
    ui/                      # Btn, GlowTag, StatBox, TabBar
    analysis/                # Scatter, Histogram, BitStream
    games/                   # Visualizador, demos interativas, StatsBadges
      visualizations/        # Modulos Canvas: flow, walk, lava, galaxy, mandala, matrix
    stream/                  # QuantumStreamView
    crypto/                  # SeedGenerator
    download/                # DataExport
```

## Executando

### Desenvolvimento local

```bash
npm install
npm run dev
```

O servidor de desenvolvimento roda em `http://localhost:5173`. A API QRNG e acessada via proxy configurado no `vite.config.js`.

### Docker

```bash
docker build -t qrng-demo .
docker run -p 80:80 qrng-demo
```

Acesse `http://localhost`. O build usa multi-stage (Node 22 + nginx Alpine) — a imagem final contem apenas os assets estaticos e o proxy para a API QRNG.

## Hardware

O sistema se conecta a um **Red Pitaya** que gera ruido quantico via ADC, exposto por uma API REST. O status de conexao (buffer, latencia, bytes gerados/consumidos) e exibido na barra superior.

Quando o hardware nao esta disponivel, o sistema usa dados quanticos pre-coletados como fallback.
