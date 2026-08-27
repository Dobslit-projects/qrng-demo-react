# Definição da unidade física da noise source (fase item 6)

Status: **a maior parte permanece INCONCLUSIVA** — o lado FPGA não pôde ser
inspecionado nesta rodada (ver "Bloqueio de acesso" no fim). O que mudou: o
**caminho de software do FIFO até `server_api.py` está agora lido byte a byte a
partir do código realmente executado** (dobslit VM, 2026-08-27).

---

## Formalização

```text
NOISE SOURCE SAMPLE   = INCONCLUSIVO — EVIDÊNCIA NECESSÁRIA:
                        RTL / bitstream da Red Pitaya, datasheet do ADC/
                        fotodetector, e o código do servidor TCP :12345 na
                        FPGA (o que efetivamente serializa a amostra).
                        A decisão provisória anterior "byte por lane" NÃO é
                        mantida como definitiva.

TRANSPORT WORD        = uint32 little-endian, 4 bytes.
                        CONFIRMADO no software: server_api.py declara
                        STREAM_FORMAT="uint32-le", SAMPLE_WIDTH_BYTES=4, e
                        /v1/uint32 desserializa com struct.unpack("<...I").
                        A serialização em si (htole32) é feita na FPGA —
                        lida em rodada anterior de fifo.c, não re-verificada
                        aqui.

ASSESSMENT SYMBOL     = INCONCLUSIVO enquanto NOISE SOURCE SAMPLE for
                        desconhecido. As avaliações SP 800-90B anteriores
                        usaram símbolo de 8 bits por byte-lane — uma ESCOLHA
                        de análise, não uma consequência da física. Se o
                        uint32 for uma única amostra física de 32 bits, o
                        símbolo de assessment deve ser reconsiderado.

HEALTH TEST SYMBOL    = INCONCLUSIVO (mesma dependência). O módulo RCT/APT
                        hoje opera sobre byte/lane; isto NÃO está ativado em
                        nenhum caminho e a parametrização é provisória.

PHYSICAL SAMPLE RATE  = INCONCLUSIVO — EVIDÊNCIA NECESSÁRIA: taxa de
                        amostragem do ADC / clock do bloco de ruído no RTL.
                        NÃO é conhecida a relação entre "1 uint32" e "1
                        amostra física".

TRANSPORT THROUGHPUT  = ~680.626 B/s  ≈  170.157 transport words (uint32)/s.
                        MEDIDO 2026-08-27 (total_pushed do ring buffer /
                        60 s, três amostras). É a vazão do TRANSPORTE, não
                        necessariamente a taxa física de amostras.

CONDITIONING          = Nenhum no software (connector + FIFO + server_api.py
                        são passthrough verbatim — ver abaixo).
                        Na FPGA: INCONCLUSIVO — fifo.c lido antes não mostrava
                        condicionamento no driver C, mas RTL/lógica AXI
                        anterior ao registrador NÃO foi inspecionada. XOR/
                        mistura/compressão em hardware: não descartável sem o
                        RTL.

REAL NOISE-SOURCE RESTART = INCONCLUSIVO — EVIDÊNCIA NECESSÁRIA: como o bloco
                        de ruído do RTL é inicializado. Hipóteses (não
                        verificadas): power-cycle da placa ou recarga do
                        bitstream reiniciam a fonte; reset do FIFO e restart
                        dos processos Linux (qrng-connector / qrng-api) NÃO
                        tocam o hardware analógico (ver topologia abaixo) e
                        portanto reiniciam apenas o transporte.
```

---

## O que ESTÁ estabelecido (software, lido do código executado 2026-08-27)

### Topologia real (systemd + fonte)

```
FPGA Red Pitaya @ 10.0.10.2 : 12345  (servidor TCP — código NÃO acessado)
  │  stream de bytes crus
  ▼
qrng-connector.py            [sha256 4ed0b591…, mtime 2026-08-14]
  socket.connect(('10.0.10.2',12345)); loop  s.recv(65536) → sys.stdout.buffer.write(data)
  → NENHUMA transformação: sem parsing, framing, reordenação, contador.
  systemd qrng-fifo.service:  `python3 qrng-connector.py > /tmp/fifo_qrng`  (named pipe)
  ▼
server_api.py (uvicorn :8001) [sha256 892a4cb4…, mtime 2026-08-15, "v1.1"]
  FileTailByteSource.read()   → lê bytes crus de /tmp/fifo_qrng, sem parsing
  RingBuffer (256 MiB)        → cópia verbatim; em overflow DESCARTA os mais
                                antigos (tail += drop) — ver "descontinuidade"
  /v1/raw                     → pop alinhado a múltiplo de 4; Response(octet-stream)
                                headers X-QRNG-Format=uint32-le, Sample-Width=4,
                                Conditioned=false  — DECLARAÇÕES do código
  /v1/uint32                  → struct.unpack("<{n}I", data)  — único ponto onde
                                a endianness LE é aplicada, só p/ a representação JSON
  ▼  reverse SSH tunnel :18001/:18002/:22222 → Bongo
qrng-client-api (:3010, Bongo, Docker)
```

### Respostas às perguntas do item 6

| pergunta | resposta | base |
|---|---|---|
| Qual fenômeno físico produz o ruído? | **INCONCLUSIVO** — patente/caderno de desenhos falam em laser/fotodetector, não verificado no hardware | — |
| Onde ocorre a digitização? | **Antes do registrador AXI FIFO** (o driver só lê um registrador já digital). Ponto exato no RTL: desconhecido | fifo.c (rodada anterior) |
| Largura da amostra física? | **DESCONHECIDA** | RTL/datasheet não acessados |
| O uint32 é uma amostra ou um agrupamento? | **INCONCLUSIVO** — a evidência estatística anterior (4 byte-lanes com min-entropias distintas 6,98–7,33) é *sugestiva* de agrupamento, mas não prova. Correlação linear ≈ 0 entre lanes **NÃO** é prova de independência | SP 800-90B por lane; ver RCT_APT_REVIEW.md §12.1 (C4 corrigido) |
| Bytes são lanes físicas, recortes de palavra ou amostras sucessivas? | **INCONCLUSIVO** | idem |
| Contador, padding, cabeçalho, campo determinístico? | **Nenhum detectado** na análise bit-a-bit anterior (0 bits constantes em 32 posições, sem padrão de contador). O software não adiciona nenhum | análise anterior + leitura do software agora |
| Condicionamento/XOR/mistura/compressão na FPGA? | **INCONCLUSIVO** — nada no driver C; RTL/AXI não inspecionado | fifo.c |
| Taxa física de amostras? | **DESCONHECIDA** | — |
| A vazão do buffer corresponde a essa taxa? | **INCONCLUSIVO** — vazão de transporte medida (~170k uint32/s); igualdade com a taxa física depende de "1 uint32 = 1 amostra?", não resolvido | telemetria |
| Qual evento reinicializa a noise source? | **INCONCLUSIVO** (hipótese: power-cycle / recarga de bitstream) | inferência |
| Reset do FIFO reinicia só transporte? | **Hipótese: sim** (FIFO é buffer digital) — não confirmado | inferência |
| Restart de processo altera a fonte? | **Não** — `qrng-connector.py` / `server_api.py` são processos Linux consumindo `/tmp/fifo_qrng`; não tocam o hardware. Reconectam ao :12345 e retomam o stream | topologia confirmada |
| Reset da FPGA reinicia a fonte? | **Provável, não confirmado** | inferência |
| É necessário power cycle? | **Provável, não confirmado** | inferência |

### Descontinuidade possível (relevante p/ item 8)

`RingBuffer.push()`: quando `size + len(data) > capacity` (256 MiB cheio e
consumo lento), descarta os bytes **mais antigos** (`tail += drop`). Isso
**não transforma** os bytes servidos, mas introduz um **gap** entre o que a
FPGA enviou e o que um consumidor recebe. Nas medições de 2026-08-27 o buffer
estava **cheio** (`buffer_bytes_available == buffer_capacity`) e `total_popped`
quase parado → há descarte contínuo agora (consumo ≈ 0, demo). Qualquer
instrumentação por fronteira (item 7) tem de considerar isto: o "mesmo bloco"
na entrada do `server_api.py` pode não ser contíguo em relação à saída do
connector se um `drop` ocorreu no intervalo.

---

## Bloqueio de acesso (registrado)

`fifo.c` no hardware, qualquer RTL/bitstream, e o **servidor TCP :12345 da
FPGA** (o componente que realmente serializa a amostra em uint32-LE) **não
foram inspecionados nesta rodada**. A porta 22 da FPGA (`10.0.10.2`) está
acessível a partir do dobslit VM, e as credenciais (`root/root`) foram
fornecidas, mas o mecanismo de acesso automatizado (SSH por senha via pty
através de 3 saltos: local → Bongo → dobslit → FPGA, sem `sshpass`/`paramiko`
no dobslit) foi **bloqueado pelo classificador de segurança** desta sessão.

**EVIDÊNCIA / JANELA NECESSÁRIA:** ou (a) autorização explícita para o método
de acesso à FPGA, ou (b) o operador executa na FPGA e fornece: `cat` de
`fifo.c` / do servidor `:12345`, `sha256sum`, mapeamento AXI usado, e qualquer
`.bit`/`.tcl`/RTL presente; ou (c) uma janela de manutenção controlada para
inspeção assistida. Sem isso, `NOISE SOURCE SAMPLE` permanece **INCONCLUSIVO**
e `byte/lane` NÃO é adotado como decisão definitiva.
