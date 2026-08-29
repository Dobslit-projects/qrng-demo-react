# Kapuã — Inventário de visualizações e fluxo de dados

**Escopo:** frontend `qrng-web:9e36a90` (produção em `https://bongo.dobslit.com`) + API `qrng-client-api:4137bfe`.
**Data:** 2026-08-29 · **Branch:** `docs/guia-usuario-kapua-20260829` (base `main`=`51c1a2d`).
**Método:** leitura do código-fonte real (`src/**`) + aceitação não destrutiva da produção. As fórmulas abaixo foram extraídas da implementação executada, não da fórmula "esperada".

---

## 0. Rotas de rede que servem bytes

| Rota (via nginx) | Alvo | Autenticação | Limite/req | Usada por |
|---|---|---|---|---|
| `/qrng/api/random` , `/qrng/api/stream` | broker FPGA "Remota (SP)" | **nenhuma** (proxy aberto) | — | páginas centrais (Kapuã, Representações Visuais, Dados) via `fetchQrngBytes(n,"remote")` |
| `/qrng/api-fpga/random` , `/qrng/api-fpga/stream` | broker FPGA "FPGA" | **nenhuma** (proxy aberto) | — | idem, quando a fonte "FPGA" é escolhida em Configurações |
| `/qrng/v1/random` , `/qrng/v1/raw` | `qrng-client-api` (token) | **Bearer** (JWT de sessão **ou** token pessoal) | 1 048 576 B | aba Desenvolvedor (Notebook/Docs) e as *Visualizações Interativas* via `fetchQrngBytesViaToken()` |
| `/qrng/v1/public/random` , `/qrng/v1/public/raw` | `qrng-client-api` (anônimo) | nenhuma | 65 536 B; ~20 req/60 s/IP | uso externo anônimo (curl/Python sem token) |
| buffer local `QRNG_PRECOLLECTED` | 10 000 bytes estáticos no bundle | — | 10 000 B/sessão, sem wraparound | fonte "Pré-coletado" (Configurações) — proveniência `unknown`, **não é medida ao vivo** |

> **Achado de auditoria (herdado, não corrigido nesta etapa):** `/qrng/api/` e `/qrng/api-fpga/` respondem 200 **sem** token. Fechar/proteger esse caminho é mudança de produção/nginx fora do escopo desta rodada.

Contrato de bytes (idêntico em todas as rotas): `TRANSPORT UNIT = byte`; `TRANSPORT WORD = uint32 little-endian` quando 4 bytes são lidos como inteiro; `SOURCE PHYSICAL SAMPLE = desconhecida`; `CONDITIONING = não confirmado / desconhecido na FPGA`; `API CONDITIONING = ausente` (o `server_api.py` repassa os bytes verbatim; header `X-QRNG-Conditioned: false`).

---

## 1. Decodificação canônica (uma única implementação)

`src/lib/qrngHelper.js` é o **único** ponto que decodifica a resposta HTTP:

- **JSON hex** (`format=hex`): `bytes[i] = parseInt(hex.substr(i*2,2),16)` — 2 chars por byte. Nenhum `parseInt` sobre o corpo inteiro; nenhuma concatenação textual; o valor decimal do hex nunca é usado como número.
- **Binário** (`format=raw`): `new Uint8Array(await r.arrayBuffer())` — N bytes exatos, sem BOM, `Content-Length = N`.
- `readUint32LE(b,i) = (b[i] | b[i+1]<<8 | b[i+2]<<16 | b[i+3]<<24) >>> 0` — little-endian, `>>> 0` garante **uint32 sem sinal**. Idêntico a `DataView.getUint32(i,true)` (testado).
- `bytesToUint32Array`: itera `i += 4` enquanto `i + 3 < len` → **bytes finais que não completam 4 são descartados** (mesma regra em todos os consumidores).
- `uint32ToFloat(n) = n / 2**32` → `[0, 1)`; máximo `0xFFFFFFFF/2^32 = 0.99999999976… < 1`.
- `bytesToDiscreteFloats(b) = b/255` → `[0, 1]` **inclusive** — quantização discreta de 256 níveis, usada **apenas** pela Análise Estatística; **não** confundir com `uint32/2^32`.
- Rejection sampling (`uniformIntFromBytes`, `uniformIntsFromBytes`, `pickInt`): `limit = floor(2^32/range)*range`; aceita `n < limit`; retorna `min + (n % range)` — **sem modulo bias**.

Zero-handling: byte de valor `0` é entpropia legítima e **nunca** é substituído por PRNG. `galaxySpiral`/`mandala` usam `bytes.length ? bytes[i] : Math.random()` — o `Math.random()` só entra se o array estiver **vazio**, e `?? 0` preserva o zero.

---

## 2. Tabela-mestra de visualizações / funcionalidades que consomem bytes

| Nome exibido | Arquivo/componente | Endpoint | Formato | Bytes/pedido | Unidade | Endianness | Transformação (exata) | Fórmula | Intervalo | Bytes/ponto | Zero | Fallback | Download | Limitação |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Dados → Raw Binário** | `data/DataSection.jsx` (`handleGenerate` mode `raw`) + `fetchQrngRawBytes` | `…/random?format=raw` | octet-stream | `dlSize` (1 B–1 MiB) | byte | — | nenhuma; grava os bytes | — | 0–255/byte | 1 | preserva | fonte pré-coletada (finita) ou erro explícito | `.bin` (`application/octet-stream`) | min-entropia/byte **não** assumida; ver aba NIST |
| **Dados → Hexadecimal** | `data/DataSection.jsx` (`fmtHex`) | `…/random?format=hex` | JSON hex | `dlSize` | byte | — | `b.toString(16).padStart(2,"0")`, separador opcional | — | `[0-9a-f]{2}` por byte | 1 | preserva | idem | `.txt`/`.json` | — |
| **Dados → Decimal / uint8** | `data/DataSection.jsx` (mode `uint8`) | `…/random?format=hex` | JSON hex→bytes | `dlSize` | byte | — | `Array.from(bytes)` | — | 0–255 | 1 | preserva | idem | `.csv`/`.txt`/`.json` | — |
| **Dados → Faixa Personalizada** | `data/DataSection.jsx` (`genWithRepeats`/`genWithoutRepeats`/`pickInt`) | `…/random?format=hex` | JSON hex→bytes | `ceil(count*6)` (≤1 MiB) | uint32 | LE | com repetição: rejection sampling; sem repetição: **Floyd F2** | `limit=⌊2³²/range⌋·range`; aceita `n<limit`; `min+(n mod range)` | `[min,max]` inteiros | 4/candidato | preserva | idem | `.json`/`.csv`/`.txt` | — |
| **Dados → Monte Carlo (floats)** | `data/DataSection.jsx` (`genMonteCarlo`) | `…/random?format=hex` | JSON hex→bytes | `count*4+16` (≤1 MiB) | uint32 | LE | `n/2³²` | `u = x/2³²` | `[0, 1)` | 4 | preserva | idem | `.csv` (15 casas) / `.json` | resolução ≈ 2,33·10⁻¹⁰ |
| **Downloads em massa** | `download/DataExport.jsx` + `fetchQrngRawBytes` | `…/random?format=raw` | octet-stream | 1 KB–50 MB (presets) / custom ≤50 MB | byte | — | nenhuma | — | 0–255 | 1 | pré-coletado (se couber) ou erro | `qrng_<n>.bin` | texto na UI diz "uint32-LE, sem conditioning; min-entropia em validação" |
| **Kapuã → nº aleatório** | `kapua/KapuaSection.jsx` (`spinRandom`) | `…/random?bytes=4&format=hex` | JSON hex→bytes | 4 | uint32 | LE | `readUint32LE(b,0)` | — | `0 … 2³²−1` | 4 | preserva | erro explícito | — | — |
| **Kapuã → download 1 MiB** | `kapua/KapuaSection.jsx` (`downloadRaw`) | `…/random?bytes=1048576&format=hex` | JSON hex→bytes | 1 048 576 | byte | — | `parseInt(hex.substr…,16)` no cliente | — | 0–255 | 1 | pré-coletado bloqueado (10 KB) → mensagem | `.bin` | usa hex (não `raw`); bytes idênticos, só o transporte difere |
| **Representações Visuais → Análise Estatística (Scatter)** | `analysis/ScatterCanvas.jsx` via `AnalysisSection` | `/qrng/api…/random?format=hex` | JSON hex→bytes | `count` (200–10 000) | byte | — | `b/255`; plota pares consecutivos | `x=v[2k]`, `y=v[2k+1]` | `[0,1]²` | 2 | preserva | **propaga erro** (sem fallback silencioso) | — | 256 níveis discretos (não `uint32/2³²`) |
| **… Distribuição (Histograma)** | `analysis/Histogram.jsx` | idem | idem | `count` | byte | — | `idx = min(⌊v·bins⌋, bins−1)`; conta | 10 bins iguais em `[0,1]` | `[0,1]` | 1 | preserva | idem | — | v=1,0 cai no último bin |
| **… Bits (64 amostras)** | `analysis/AnalysisSection.jsx` | idem | idem | `count` | byte | — | `v > 0.5 ? 1 : 0` (primeiros 64) | — | {0,1} | 1 | preserva | idem | limiar em 0,5 |
| **… Testes estatísticos (badges)** | `games/StatsBadges.jsx` + `games/statsTests.js` | idem (reusa os bytes) | — | ≥20 (badge some se menos) | byte | — | monobit / runs / Chi² / Shannon | ver §4 | `%`, `z`, `χ²`, `bits` | — | preserva | idem | **heurística de navegador**, NÃO é SP 800-90B nem min-entropia |
| **… PRNG × QRNG (comparação)** | `games/QuantumVisualizer.jsx` | **QRNG:** `/qrng/v1/random` (token) 8192 B; **PRNG:** LCG interno | JSON hex→bytes | 8192/refill | byte | — | QRNG: `b` cru p/ o módulo de viz; PRNG: LCG quantizado a 8 níveis | LCG: `s' = (s·1103515245 + 12345) mod 2³²` | — | var. | preserva | **`Math.random()` rotulado** ("QRNG · Math.random() — erro de rede/pré-coletado esgotado") | — | rótulo do fallback é discreto; o título permanece "QRNG" |
| **… Galáxia** | `games/visualizations/galaxySpiral.js` | via QuantumVisualizer (token) | bytes | ~1800 init + 900/perturbação | byte | — | `b/255` → raio/ângulo/brilho/tamanho da estrela | `r=(b1/255)·0.88+0.05`; `spread=((b2/255)−0.5)·0.6`; `size=1+(b1/255)·2` | posições no canvas | 2/estrela | preserva | `Math.random()` só se buffer vazio | — | espiral: distribuição final **não** uniforme (por design) |
| **… Mandala** | `games/visualizations/mandala.js` | idem | bytes | ~2/ponto | byte | — | `b/255` → ângulo setorial e raio; simetria N | `sectorAngle=(b/255)·(2π/SYMMETRY)`; `r=radiusByte/255` | canvas polar | 2/ponto | preserva | `Math.random()` só se buffer vazio | — | idem |
| **… LCG Cracker** | `games/visualizations/prngCracker.js` | — (opera sobre o **PRNG**) | — | — | uint32 | — | recupera `a,c` do LCG a partir de saídas (didático) | `value=(seed>>>16)/65536` | `[0,1)` | — | — | n/a (é PRNG por definição) | — | **demonstra fragilidade do PRNG**, não do QRNG |
| **… MT19937 Clone** | `games/visualizations/mtClone.js` | — (opera sobre o **PRNG**) | — | — | uint32 | — | clona o estado do Mersenne Twister após 624 saídas (didático) | tempering padrão do MT | uint32 | — | — | n/a | — | idem — PRNG intencional |
| **… Sonificação** | `games/visualizations/sonification.js` + `audioEngine.js` | QRNG via QuantumVisualizer (token) / PRNG interno | bytes | fluxo contínuo | byte | — | byte → nota (mapeamento de escala) | evento `{type:"note", byte}` → `playNote(byte)` | tom audível | ~1/nota | preserva | `Math.random()` só se buffer vazio | — | ruído de percussão do sintetizador usa `Math.random()` (amostra de áudio, **não** representa dados) |
| **Representações Visuais → Fluxo em tempo real** | `analysis/StreamPanel.jsx` + `qrngApi.connectQRNGStream` | `/qrng/api…/stream` | octet-stream (SSE-like) | fluxo | byte | — | `chunk[i]/255` → partículas / onda / grade hex | `x=chunk[i]/255`, `y=chunk[i+1]/255`; onda `y=(1−b/255)·H` | `[0,1]` | 2 (partícula) / 1 (onda) | preserva | encerra com erro após 90 s sem dados | — | visual; sem alegação estatística |
| **Aplicações → Chave Quântica** | `applications/ApplicationsSection.jsx` `KeyCard` | `/qrng/api…/random` | JSON hex | 16–1024 | byte | — | exibe hex | — | — | — | — | **DESABILITADA** (`blockedOperational=true`) | — | animação de "scramble" usa `Math.random()` enquanto carrega (cosmético); geração real bloqueada |
| **Aplicações → Seed para IA** | idem `AISeedCard` | `/qrng/api…/random` | JSON hex→bytes | 8 | uint32 | LE | `u32[0]` (seed32); `u32[0]·2³² + u32[1]` (seed64, BigInt) | — | uint32 / uint64 | 8 | preserva | **DESABILITADA** | — | geração operacional bloqueada |
| **Aplicações → Monte Carlo π** | idem `MonteCarloCard` | `/qrng/api…/random` | JSON hex→bytes | `nPoints*8` | uint32 | LE | `x=u32[2k]/2³²`, `y=u32[2k+1]/2³²`; `inside += (x²+y²≤1)` | `π̂ = 4·inside/nPoints`; `erro% = |π̂−π|/π·100` | `x,y ∈ [0,1)` | 8 | `?? 0` (ponto (0,0), conta como dentro) | erro explícito | — | `?? 0` só ocorre se o buffer vier curto (não ocorre com `bytes=nPoints*8`) |
| **Aplicações → Sorteio Auditável** | idem `RaffleCard` | `/qrng/api…/random` | JSON hex→bytes | 32 | uint32 | LE | `uniformIntFromBytes(0, n−1, bytes)` | rejection sampling (§1) | `[0, n−1]` | 4/candidato | preserva | erro explícito | comprovante em texto | — |
| **Aplicações → Moeda** | idem `GamesCard` | `/qrng/api…/random` | JSON hex→bytes | 1 | bit | — | `(b[0] & 1) === 0 ? CARA : COROA` | — | {CARA,COROA} | 1 | preserva | erro explícito | — | usa só o LSB de 1 byte |
| **Aplicações → Dado** | idem `GamesCard` | `/qrng/api…/random` | JSON hex→bytes | 16 | uint32 | LE | `uniformIntFromBytes(1, 6, bytes)` | rejection sampling | `[1,6]` | 4/candidato | preserva | erro explícito | — | — |
| **Aplicações → Random Walk** | idem `RandomWalkCard` | `/qrng/api…/random` | JSON hex→bytes | `ceil(steps/4)` | 2 bits | — | `byte&3`, `(byte>>2)&3`, `(byte>>4)&3`, `(byte>>6)&3` → ↑↓←→ | — | grade 2D | 0,25 (2 bits) | preserva | erro explícito | — | 4 passos/byte, sem viés |
| **Aplicações → Otimização Estocástica** | idem `OptimCard` | `/qrng/api…/random` | JSON hex→bytes | `n*4` | uint32 | LE | `x = (u32/2³²)·2π`; maximiza `f(x)=sin x + cos 2x` | — | `x ∈ [0, 2π)` | 4 | preserva | erro explícito | — | busca aleatória pura |
| **Barra de Hardware** | `layout/HardwareStatusBar.jsx` | `/qrng/api…/health` (poll) | JSON | — | — | — | badge de proveniência de `health.provenance_detail.actual_origin` | — | — | — | — | — | — | **nunca** rotula "live" sem `actual_origin==="live"` |
| **Teste NIST** | `nist/NISTSection.jsx` | `/qrng/nist/nist/*` | JSON | — (upload/arquivo do servidor) | — | — | executa a suíte SP 800-90B no servidor; exibe IID/não-IID/min-H | ver §5 do guia | bits/símbolo | — | — | banner "SINTÉTICO" se o motor for fake (produção: motor real) | — | resultado pertence à **amostra**, não é certificado da fonte |

Legenda de classificação `Math.random`/PRNG (§9 do pedido):

| Ocorrência | Arquivo:linha | Classificação |
|---|---|---|
| `data[i] = Math.random()*2-1` (ruído de percussão) | `audioEngine.js:134` | **FUNÇÃO VISUAL/SONORA NÃO RELACIONADA A DADOS** |
| partículas de fundo animadas | `kapua/KapuaSection.jsx:67-70` | **FUNÇÃO VISUAL NÃO RELACIONADA A DADOS** |
| hex "scramble" enquanto a chave carrega | `applications/ApplicationsSection.jsx:139` | **FUNÇÃO VISUAL** (e a geração está desabilitada) |
| LCG (`lcgNext`, `generatePRNGSequence`, `prngRandInt`) | `prng.js` | **PRNG INTENCIONAL PARA COMPARAÇÃO** |
| LCG quantizado a 8 níveis (lado PRNG das viz) | `games/QuantumVisualizer.jsx:34-45` | **PRNG INTENCIONAL PARA COMPARAÇÃO** |
| `prngCracker.js`, `mtClone.js` | idem | **PRNG INTENCIONAL PARA COMPARAÇÃO** (didático) |
| `bytes.length ? bytes[i] : Math.floor(Math.random()*256)` | `galaxySpiral.js:11-12`, `mandala.js:80-81` | **FALLBACK** — só quando o array de bytes está vazio; não substitui zeros |
| `qrngBufferRef` underrun → `Math.random()` por byte | `games/QuantumVisualizer.jsx:128,147` | **FALLBACK** — rotulado na UI como "Math.random() — erro de rede / pré-coletado esgotado" |
| `getPrecollectedBytes` / `QRNG_PRECOLLECTED` | `qrngFallbackData.js`, `qrngHelper.js` | **DADO QRNG** pré-coletado (proveniência `unknown`, finito, sem wraparound) — nunca alimenta geração criptográfica |

**Nenhum uso de `Math.random()` é apresentado como QRNG.** Os fallbacks para `Math.random()` são: (a) rotulados na interface, ou (b) restritos ao caso "array de bytes vazio", ou (c) ruído de áudio sem relação com os dados.

---

## 3. Fórmulas verificadas no código executado

### 3.1 uint32 little-endian
`x = b₀ + 2⁸·b₁ + 2¹⁶·b₂ + 2²⁴·b₃` — `src/lib/qrngHelper.js:244` (`readUint32LE`). Confere com `DataView.getUint32(i, true)` (regressão em `qrngHelper.test.js`).

### 3.2 Normalização uniforme
`u = x / 2³²` — `src/lib/qrngHelper.js:254` (`uint32ToFloat`) e `data/DataSection.jsx:74` (`genMonteCarlo`). `0 ≤ u < 1` (máx `0xFFFFFFFF/2³² = 0.99999999976…`). **Nunca** divide por `2³²−1`; **nunca** produz `≥ 1`.

### 3.3 Distribuição exponencial (biblioteca `qrngHelper`, ainda não exposta numa tela)
`exponentialFromUniform(u, mean) = -mean · ln(1 − u)` — `src/lib/qrngHelper.js:262`. **Parâmetro = média `μ`** (não taxa `λ`). `u` vem de `uint32ToFloat`, logo `u ≤ 0.99999999976 < 1` → `ln(1−u)` sempre finito; `u = 0` → `X = 0` (válido). **Não há hoje uma visualização "Distribuição Exponencial" na interface de produção** — a função existe na biblioteca e tem teste (`qrngHelper.test.js`), mas nenhuma página a chama. O guia documenta isso como *função disponível na biblioteca, sem tela dedicada*.

### 3.4 Monte Carlo / π
`applications/ApplicationsSection.jsx` `MonteCarloCard.run`:
- `x_i = uint32ToFloat(u32[2i])`, `y_i = uint32ToFloat(u32[2i+1])` — **8 bytes por ponto** (2 uint32 LE).
- `inside = Σ [x_i² + y_i² ≤ 1]`.
- `π̂ = 4 · inside / nPoints`.
- `erro% = |π̂ − π| / π · 100`.
- `x,y ∈ [0,1)` — nunca `= 1`. Canvas, contador (`inside/total`) e valor `π̂` derivam do mesmo laço (consistentes).
- `?? 0`: se `u32[k]` for `undefined` (buffer curto), o ponto vira `(0,0)` e conta como "dentro". Com `bytes = nPoints*8` o buffer nunca fica curto na prática.

`data/DataSection.jsx` `genMonteCarlo` (modo Monte Carlo da aba Dados): `nums.push(n / 2³²)` — só gera os floats `[0,1)`, não estima π. `bytesConsumed = count·4`.

### 3.5 Faixa personalizada / modulo bias
`pickInt` / `uniformIntFromBytes` / `uniformIntsFromBytes`: `range = max−min+1`; `limit = ⌊2³²/range⌋·range`; percorre uint32 LE, **rejeita** `n ≥ limit`, retorna `min + (n mod range)`. Elimina o modulo bias (regressão em `qrngHelper.test.js` com `range=100`). Sem repetição: **algoritmo de Floyd F2** (`genWithoutRepeats`), uniforme sobre k-subconjuntos.

### 3.6 LCG de comparação (`src/prng.js`)
`next = (s · 1103515245 + 12345) mod 2³²` (via `Math.imul`); `value = (next >>> 16) / 65536 ∈ [0,1)`. Determinístico por seed. Nas *Visualizações Interativas* o lado PRNG ainda é quantizado a **8 níveis** para expor visualmente a estrutura do LCG.

---

## 4. Testes estatísticos do navegador (`games/statsTests.js`) — NÃO são SP 800-90B

| Teste | Cálculo | Critério de "passou" | O que NÃO é |
|---|---|---|---|
| Monobit | `ones/total` dos bits | `|ratio − 0.5| < 0.03` | não é o Frequency Test completo do SP 800-22 |
| Runs | `runs`, `E[runs]=1+2npi(1−pi)`, z-score | `|z| < 2.58` | idem |
| Chi² | `Σ (obs−esp)²/esp` sobre 256 valores | `χ² < 310` (df=255, p≈0.01) | não usa tabela exata |
| Shannon | `−Σ p·log₂ p` por byte | `> 7.5` bits | **não é min-entropia**; não é SP 800-90B; entropia de Shannon ≠ H∞ |

Servem para dar um sinal rápido lado a lado (PRNG × QRNG). **Não** produzem crédito de entropia nem conformidade.

---

## 5. Diferenças produção × branch

Nenhuma alteração de comportamento foi feita nesta branch até aqui — apenas documentação, exemplos e um script de verificação (`docs/**`). O frontend e a API descritos aqui são **os de produção** (`qrng-web:9e36a90`, `qrng-client-api:4137bfe`). Qualquer correção de bug encontrada será listada em `USER_GUIDE_EVIDENCE_MATRIX.md` e **não** será descrita no guia como "disponível em produção" até deploy autorizado.
