# Inspeção READ-ONLY da FPGA — resultado (2026-08-28)

> **Acesso autorizado explicitamente pelo usuário** (cadeia SSH fornecida). Feita
> por SSH aninhado (paramiko, canais `direct-tcpip`): local → Bongo `2.24.117.58`
> → dobslit `192.168.0.42` (via túnel reverso `127.0.0.1:22222` na Bongo) → FPGA
> `10.0.10.2` (`root`). **Somente leitura.** Nenhuma escrita, nenhum restart,
> nenhum reload de bitstream, nenhum power-cycle, **nenhum acesso MMIO**
> (justificativa no fim), **nenhum segundo consumidor** de `:12345` ou do FIFO.

## Identidade

| item | valor |
|---|---|
| host | `rp-f0d1e2` (MAC …26:32:f0:d1:e2) — Red Pitaya |
| kernel | `Linux rp-f0d1e2 5.15.0-xilinx #1 SMP PREEMPT ... armv7l` (Zynq-7000) |
| OS | Ubuntu 22.04.4 LTS |
| Red Pitaya | Version `2.00-a0457d3aa`, Build 37, U-Boot `redpitaya-v2022.1`, Kernel branch `redpitaya-v2024.1` |
| FPGA manager | `Xilinx Zynq FPGA Manager`, state **`operating`** (bitstream carregado) |
| carga | `fifo` a **96,7 % CPU**, `nc` a **86,7 %** — a placa está saturada (o sshd fica intermitente) |

## O servidor `:12345` — é `nc`, não um binário próprio

```
ss -tlnp: LISTEN 0.0.0.0:12345  users:(("nc",pid=399,fd=3))
ps: root 389  /bin/bash -c /root/fifo | nc -k -l 0.0.0.0 12345
    root 397  /root/fifo                       (96.7% CPU)
    root 399  nc -k -l 0.0.0.0 12345           (86.7% CPU)
nc: /usr/bin/nc.openbsd  sha256 e7c80430357fb9e8ee25464d484622d25ca39359b767b7c0f0162f13057421a4
```

`fifo` (pid 397) **fd 1 → `pipe:[4202]`**; `nc` (pid 399) **fd 0 → `pipe:[4202]`**.
Ou seja: **`/root/fifo | nc -k -l 0.0.0.0 12345`**. `nc` é um relay de bytes puro
(openbsd `nc`, sem `-C`/CRLF, sem framing). `-k` = continua escutando após o
cliente desconectar (uma conexão por vez).

## `/root/fifo.c` — o driver (lido na íntegra)

| | |
|---|---|
| fonte | `/root/fifo.c` — sha256 `8c738fbf47989b0175bf903c04f0efc3eb0626831442535a349df540bc2e5a05` (2131 B, mtime 2026-03-29) |
| binário em execução | `/root/fifo` == `/root/fifo.binary` — sha256 `973840273f0354c2203ab6ba43224270452bbcdb932d030e686bc61afa15c340` |
| versão anterior | `/root/fifo.c.old` sha256 `8a338ad7534b8474f54392b01f0099f3a08993c4833e549fb3f748e364ef2367` |

```c
#define AXI_FIFO_ADDR   0x43C00000
#define AXI_FIFO_WINDOW 0x20000

fd = open("/dev/mem", O_RDWR | O_SYNC);
axi_fifo = mmap(NULL, 0x20000, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0x43C00000);

/* startup, diagnóstico p/ STDERR (nunca no stdout binário) */
fprintf(stderr, "ISR 0x0 = %x\n", *axi_fifo);      /* lê ISR (offset 0x00) */
*axi_fifo = 0xFFFFFFFF;                              /* ESCREVE ISR = 0xFFFFFFFF (write-1-to-clear) */
fprintf(stderr, "ISR 0x0 = %x\n", *axi_fifo);
*(axi_fifo + (0x18 / 0x4)) = 0xA5;                   /* ESCREVE RDFR (0x18) = 0xA5  -> reset do RX FIFO */

while (run) {
    num = *(axi_fifo + (0x11000 / 0x4));             /* LÊ RDFD (0x11000) -> POPa 1 palavra de 32 bits */
    *axi_fifo = 0xFFFFFFFF;                          /* ESCREVE ISR = 0xFFFFFFFF (limpa após cada leitura) */
    le = htole32(num);                              /* little-endian explícito, 4 bytes fixos */
    if (write_all(&le, sizeof(le)) != 0) break;     /* stdout fechado / EPIPE -> sai limpo */
}
```

`write_all()`: laço até escrever tudo; `continue` em `EINTR`; retorna `-1` em
`write()==0` ou erro → `break`. `signal(SIGPIPE, SIG_IGN)` — EPIPE detectado pelo
retorno, não por sinal.

### O que isso PROVA (fronteira FIFO → fifo.c → TCP)

| pergunta | resposta |
|---|---|
| largura da palavra | **32 bits fixos.** `num` é `uint32_t`; `write_all(&le, sizeof(le))` = **4 bytes por leitura** |
| operação de leitura | **1 read de RDFD (`0x11000`) = 1 POP de uma palavra de 32 bits** do AXI4-Stream FIFO (Xilinx PG080). Leitura **destrutiva** — consome a palavra |
| serialização | `htole32(num)` — **little-endian explícito**. Na Zynq (armv7l LE) é no-op, mas é intencional e fixo em 4 bytes. **Sem** `sprintf`/`%u`/decimal** (isso era o `fifo.c.old` — ver abaixo) |
| `htole32` ou equivalente | **SIM**, `htole32` de `<endian.h>` |
| escrita no socket | `fifo` **não** fala com o socket. `fifo` → `write(STDOUT)` → `pipe:[4202]` → `nc` → TCP. `nc` é um relay puro |
| `write()` parcial | **tratado** — `write_all()` reencaminha o restante; `EINTR` → `continue` |
| framing / delimitadores | **NENHUM.** `write(4 bytes)` num laço, sem contador/cabeçalho/padding/separador |
| `fprintf` / `%u` / serialização textual | **NÃO** no `fifo.c` atual. Ver `fifo.c.old` |
| alinhamento em 4 bytes | **garantido na origem** — cada `write_all` é exatamente 4 bytes. (O desalinhamento só pode surgir a jusante, numa reconexão do connector que perca 1–3 bytes) |
| condicionamento (no driver C) | **NENHUM.** `fifo.c` lê RDFD e escreve o valor cru. XOR/whitening/hash: ausentes no driver. **No RTL** (a montante do FIFO): não inspecionado — ver "Bitstream / RTL" |
| contador / padding / campo determinístico | **nenhum** adicionado pelo `fifo.c` |
| reset do bloco antes de ler | `fifo.c` escreve `RDFR (0x18) = 0xA5` **uma vez no startup** → esvazia o RX FIFO (buffer digital). **Não** toca o front-end analógico nem o RTL |
| ISR limpa a cada leitura | `*axi_fifo = 0xFFFFFFFF` após cada read — incomum, inofensivo (write-1-to-clear) |
| stderr no stream? | **NÃO** — `fprintf(stderr, ...)` vai para fd 2; o stdout binário (fd 1) só recebe os 4 bytes de `write_all` |

### `/root/fifo.c.old` — a serialização textual EXISTIA e foi REMOVIDA

```c
store = fopen("/dev/stdout", "wb");
...
*(axi_fifo + (0x18/0x4)) = 0xA5;   // RDFR
while (run) {
    num = *(axi_fifo + (0x11000/0x4));
    *axi_fifo = 0xFFFFFFFF;
    fprintf(store, "%u", num);       // <<< DECIMAL ASCII, SEM SEPARADOR entre números
}
```

`fprintf(store, "%u", num)` concatenava os inteiros em decimal **sem nenhum
delimitador** → sequência ambígua (não dá para saber onde um número termina).
**Defeito real, no `fifo.c.old`.** O `fifo.c` atual (em execução) trocou isso por
`htole32` + `write(4)` binário fixo — **resolvido**.

## Topologia e o que reinicia a noise source

```
[shot noise óptico: laser + fotodetector]      (evidência: /root/numbers_laser_on.txt,
   │                                             numbers_shotnoise.txt, numbers_lab_noise.txt,
   ▼                                             adc_counts_laser_on.txt)
ADC Red Pitaya (Zynq) ─► RTL de aquisição/ruído (bitstream stream_app.bit.bin) ─► AXI4-Stream FIFO @ 0x43C00000
   ▼
/root/fifo  (mmap /dev/mem; RDFD read; htole32; write(4) — laço)       [pid 397]
   ▼  pipe:[4202]
nc -k -l 0.0.0.0 12345                                                [pid 399]
   ▼  TCP :12345
qrng-connector.py (dobslit)  → /tmp/fifo_qrng  → server_api.py :8001  → túnel :18001 → Bongo :3010
```

`/root/init_demo.sh`: `/opt/redpitaya/bin/fpgautil -b /root/stream_app.bit.bin`
(carrega o bitstream) e, comentado, `while true; do /root/fifo; sleep 5; done`.
`/root/qrng_legacy_screen_command.txt`: o original rodava
`/root/fifo | nc -l 0.0.0.0 12345` dentro de um `screen` (sessão
`394.pts-0.rp-f0d1e2`, criada 24/03/2026); nota diz que "o novo serviço
`qrng-stream.service` substitui isso com loop de restart".

| evento | efeito na noise source |
|---|---|
| **`fpgautil -b stream_app.bit.bin`** (reload de bitstream) | **reinicia a noise source** — toda a lógica de fabric (incl. o bloco RTL de ruído/aquisição) é reinicializada |
| **power-cycle / reset da placa** | reinicia a noise source (analógico + digital) |
| restart de `/root/fifo` | escreve `RDFR=0xA5` → esvazia só o **AXI FIFO** (buffer digital, ~KB). **NÃO** é restart da noise source |
| restart de `qrng-connector.py` / `server_api.py` (dobslit) | só transporte a jusante; não toca a FPGA |

**⇒ Definição do evento de restart da campanha (mil reinicializações):** reload de
`stream_app.bit.bin` via `fpgautil` (ou power-cycle). Fecha uma dependência que
estava aberta em `RESTART_CAMPAIGN.md`.

## Bitstream / RTL — NÃO inspecionado

- `fpga_manager` state = `operating`; `init_demo.sh` carrega
  `/root/stream_app.bit.bin` (2 083 744 B). Também presentes:
  `/root/dac_test.bit.bin`, `/opt/redpitaya/boot.bin`, `/opt/redpitaya/fpga/`.
- **Não há projeto Vivado / RTL (`.v`/`.vhd`/`.xpr`/`.tcl`/`.bd`) no filesystem da
  FPGA** (busca em `/root`, `/opt/redpitaya`). O `.bit.bin` é binário; extrair a
  lógica exigiria o projeto-fonte ou engenharia reversa do bitstream.
- **Consequência:** **não é possível descartar condicionamento/whitening/mistura
  DENTRO do RTL** entre o ADC e o FIFO. O `fifo.c` só vê a saída do FIFO. A
  análise estatística anterior (0 bits constantes, sem padrão de contador,
  min-entropia 6,9–7,1) é *consistente com* ausência de condicionamento pesado,
  mas não prova.
- Fenômeno físico: **shot noise óptico (laser + fotodetector)** — forte evidência
  circunstancial pelos nomes dos arquivos de caracterização (`laser_on`,
  `shotnoise`, `lab_noise`, `adc_counts_laser_on`). **Não confirmado** por
  datasheet do fotodetector nem pelo RTL.
- `/root/parameters.txt`: `ch1: 0xBD0` (3024), `ch4: 0xC53` (3155) — valores de
  12 bits, provavelmente offset/threshold de ADC por canal. Semântica exata
  pendente do `server.py`/`server_api.py` da FPGA (sshd instável — não obtidos
  nesta rodada).

## Taxa física de amostragem — não confirmada nesta rodada

O `dmesg`/`iio`/`.bash_history` não foram capturados (sshd da FPGA instável sob a
carga do `fifo`). A **vazão de transporte** medida na fronteira de software
permanece **699 220 B/s ≈ 174 805 uint32/s** (`/health`, 2026-08-28). A relação
"1 uint32 = N amostras físicas do ADC" **continua desconhecida** — depende do
RTL (decimação/agrupamento) e da taxa do ADC (o ADC da Red Pitaya amostra a
125 MS/s; o RTL quase certamente decima). **INCONCLUSIVO.**

## MMIO — NÃO executado (justificativa)

O `fpga_readonly_inspect.sh` tem uma seção `devmem 0x43C00000..+0x1C`. **Não foi
executada.** Motivos, agora com o `fifo.c` em mãos:
- **`0x11000` (RDFD) é leitura destrutiva** — `fifo.c` é o leitor legítimo único;
  ler isso roubaria palavras do stream.
- Mesmo `0x00` (ISR, read-only em leitura) e `0x1C` (RDFO, ocupação, read-only):
  um **segundo processo mapeando `/dev/mem` em `0x43C00000`** é um **segundo
  acessador do periférico AXI FIFO ao vivo**, concorrente com o `fifo.c` (que
  escreve ISR a cada iteração). Isso viola "não abrir segundo consumidor da
  fonte" e poderia correr com as escritas do `fifo.c`.
- O valor marginal (snapshot de ISR/ocupação) **não muda** a matriz — o `fifo.c`
  + a PG080 já dão a semântica dos registradores.

Mapa de registradores (do `fifo.c` + Xilinx PG080 "AXI4-Stream FIFO"):

| offset | nome | semântica | uso no `fifo.c` |
|---|---|---|---|
| `0x00` | ISR | Interrupt Status. Leitura = status; escrita = write-1-to-clear | lê (diag) + escreve `0xFFFFFFFF` no startup e após cada read |
| `0x18` | RDFR | Receive Data FIFO Reset. Escrever `0x000000A5` reseta o RX FIFO | escreve `0xA5` **uma vez** no startup |
| `0x1C` | RDFO | Receive Data FIFO Occupancy (palavras disponíveis). Read-only, não destrutivo | **não usado** |
| `0x11000` | RDFD | Receive Data FIFO Data. **Ler = POP destrutivo** de uma palavra | lido a cada iteração do laço |

## `qrng-stream.service` — o unit em execução (obtido no 2º acesso)

```ini
# /etc/systemd/system/qrng-stream.service     (ÚNICO unit em /etc/systemd/system/)
[Service]
WorkingDirectory=/root
ExecStartPre=/opt/redpitaya/bin/fpgautil -b /root/stream_app.bit.bin
ExecStart=/bin/bash -c '/root/fifo | nc -k -l 0.0.0.0 12345'
Restart=always
RestartSec=5
KillMode=control-group
StandardOutput=journal
StandardError=journal
```

**⇒ Todo `systemctl restart qrng-stream` reCARREGA o bitstream
(`ExecStartPre = fpgautil -b stream_app.bit.bin`) e então sobe `fifo | nc`.**
`KillMode=control-group` mata `fifo` + `nc` juntos. `Restart=always RestartSec=5`.

Isto FECHA a definição do evento de restart da noise source
(`RESTART_CAMPAIGN.md`): **`systemctl restart qrng-stream`** (que já embute o
reload do bitstream) OU power-cycle. Um restart do `qrng-connector.py` /
`server_api.py` da dobslit **não** é um restart da noise source.

## Servidores `/dev/urandom` na FPGA — protótipos MORTOS, fora da cadeia

`/root/server_api.py` (sha `c98fe57420b694cd0ee8b3ace010340c8e91c9ed64d904e982251a46f5deb699`)
e `/root/server.py` (sha `07c5ad9ad99d5f821cac9eb1532086d69773a928949f4d7a85ecba892af89f0a`)
**ambos têm `SOURCE_FILE = "/dev/urandom"`** — são protótipos legados
("prototipagem antes de ligar DMA/FIFO direto"). **NÃO estão em execução**
(o único unit é `qrng-stream.service`; `ps` só mostra `fifo`, `nc`, `jupyter`).
**NÃO fazem parte da cadeia produtiva** — a cadeia usa `fifo → nc :12345`
(FIFO real do AXI), e a jusante o `server_api.py` da **dobslit** (que lê
`/tmp/fifo_qrng`, alimentado pelo `nc :12345`). `/root/testelocal/server_api.py`
(4326 B) é outro protótipo local.

> **Observação de higiene (não é um risco da cadeia atual):** se alguém apontasse
> o `qrng-connector.py` para `10.0.10.2:8001`/`:9000`/`:12345`-de-um-desses em vez
> do `nc :12345`, receberia `/dev/urandom` (PRNG do kernel) rotulado como QRNG.
> Hoje o connector aponta para `10.0.10.2:12345` = `nc` = FIFO real. Recomenda-se
> **remover/desabilitar** esses protótipos da FPGA.

## Taxa física de amostragem — ainda INCONCLUSIVA

`dmesg` só revelou o **XADC** (conversor interno de housekeeping do Zynq —
temperatura/tensão), não o ADC de RF do caminho de sinal:
`xadc: 961538` / `147928` / `36982` (Hz do XADC, irrelevante para o sinal).
O ADC de RF da Red Pitaya é 125 MS/s / 14 bits; o RTL (`stream_app.bit.bin`)
quase certamente **decima**, mas o fator de decimação e a taxa efetiva que
alimenta o FIFO **não** apareceram no `dmesg` nem no `.bash_history`
(sem comandos de vivado/decimação). **A relação "1 uint32 = N amostras do ADC"
permanece desconhecida.** Vazão de transporte medida: 699 220 B/s ≈
174 805 uint32/s.

`.bash_history` confirma o build: `gcc -O3 -g fifo.c -o fifo`, e o ciclo
`nano fifo.c → gcc → fpgautil -b stream_app.bit.bin → ./fifo | nc -l 0.0.0.0 12345`.

## Também presente na FPGA (não relevante para a cadeia produtiva)

- `jupyter-lab` rodando (pid 215).
- Arquivos de caracterização: `numbers_qrng.txt` (10,7 MB), `numbers.txt`
  (10,7 MB), `numbers_{laser_on,lab_noise,shotnoise,sine_1k,noise_gen_*}.txt`,
  `adc_counts_laser_on.txt`, `spidev_test.c`, `test.c`.
- Túnel: `/root/init_ssh_tunnel.sh` → `-R 18002:127.0.0.1:8001 root@189.126.105.45`
  (endereço antigo; a cadeia atual usa o `qrng-tunnel-newvm.service` da dobslit).

## Pendências

- **O projeto RTL / Vivado de `stream_app.bit.bin`** — **não está na FPGA**
  (busca em `/root`, `/opt/redpitaya`; sem `.v`/`.vhd`/`.xpr`/`.tcl`/`.bd`).
  Exigiria o repositório do design ou engenharia reversa do bitstream. Sem ele:
  **não é possível descartar condicionamento/whitening no RTL** entre o ADC e o
  FIFO, nem confirmar a taxa de amostragem / decimação.
- **Taxa física do ADC de RF + fator de decimação do RTL** — não expostos no
  `dmesg` (só o XADC de housekeeping) nem no `.bash_history`.
- **Datasheet do fotodetector / esquemático** que confirme o fenômeno físico
  (shot noise óptico) e a semântica de `parameters.txt` (`ch1`/`ch4`).

## Higiene recomendada (não bloqueia a cadeia atual)

- Remover/desabilitar `/root/server_api.py`, `/root/server.py`,
  `/root/testelocal/server_api.py` (protótipos `/dev/urandom`).
- Consolidar `fifo.c`/`fifo.c.old` (manter só o atual, versionado no repo do
  projeto físico).
