# Inspeção não destrutiva da FPGA (fase item 8)

## Estado

```text
INSPEÇÃO READ-ONLY DA FPGA: NÃO EXECUTADA (2 rodadas) — BLOQUEADA POR TOOLING
MOTIVO: a única forma de acesso ao host da FPGA (10.0.10.2) é um login SSH
        interativo por SENHA, encadeado por dois saltos (Bongo 2.24.117.58 ->
        túnel reverso 127.0.0.1:22222 -> dobslit 192.168.0.42 -> 10.0.10.2).
        O classificador de segurança do ambiente BLOQUEIA esse padrão mesmo
        para comandos exclusivamente de leitura. Tentado 2x (rodadas de
        2026-08-27 e 2026-08-28) com comandos read-only; negado. NENHUMA
        tentativa de contornar o bloqueio.
CONFIRMADO SEM LOGAR NA FPGA:
  - 10.0.10.2:22 aberto e responde (nc -zv a partir de dobslit);
  - pipeline de software a jusante (connector, FIFO, server_api.py) é
    passthrough verbatim — hashes conferidos (NOISE_SOURCE_UNIT.md);
  - o server_api.py real NÃO emite X-QRNG-Captured-At/-Capture-Id
    (PROVENANCE_REAL_UPSTREAM.md).
DESBLOQUEIO: (a) uma regra de permissão de Bash que autorize SSH read-only
para 10.0.10.2 pela cadeia Bongo->dobslit; OU (b) o operador executa o
handoff abaixo e devolve stdout/stderr.
```

## HANDOFF PARA O OPERADOR (item 9)

| item | valor |
|---|---|
| **Script read-only** | `physical-layer/fpga_readonly_inspect.sh` (neste repo) |
| **SHA-256 do script** | `cc7a80083031ceaca341c9b5905a64307c356461975c660d8b5514601ea118d6` |
| **Onde rodar** | como `root@10.0.10.2` (Red Pitaya) |
| **O que o script faz** | só LÊ: identidade/SoC, bitstream+hashes, processo do servidor `:12345` (exe + sha256 + cmdline + environ sem segredos), `fifo.c`/RTL se presente, **leitura ÚNICA** dos registradores `0x43C00000..+0x1C` (NUNCA lê `0x43C11000`, o FIFO de dados), ADC/clock/`sampling_frequency` via IIO + `dmesg`, units systemd / `rc.local` / `crontab` |
| **O que o script NÃO faz** | nenhuma escrita em registrador; nenhum restart de serviço; nenhuma alteração de arquivo; nenhum reload de bitstream; nenhum segundo consumidor; nenhum power-cycle |

### Comandos exatos

```sh
# 1. transferir o script para a FPGA (ex.: a partir da dobslit):
scp /caminho/para/fpga_readonly_inspect.sh root@10.0.10.2:/tmp/

# 2. na FPGA, conferir o hash ANTES de rodar:
ssh root@10.0.10.2
sha256sum /tmp/fpga_readonly_inspect.sh
#   deve imprimir: cc7a80083031ceaca341c9b5905a64307c356461975c660d8b5514601ea118d6
#   se NÃO bater, PARE e reporte.

# 3. rodar, salvando stdout e stderr SEPARADOS:
sh /tmp/fpga_readonly_inspect.sh > /tmp/fpga_inspect.out 2> /tmp/fpga_inspect.err

# 4. conferir que nada travou e ver o tamanho:
echo "exit=$?"; wc -l /tmp/fpga_inspect.out /tmp/fpga_inspect.err

# 5. DEVOLVER os dois arquivos (out + err) para quem pediu a inspeção
#    (anexar ou colar; ~algumas dezenas de KB).
```

### Saída esperada (forma)

Blocos `===== META =====`, `HARDWARE / SOC`, `BITSTREAM / FPGA FABRIC`,
`SERVIDOR TCP :12345`, `FONTE fifo.c / RTL`, `REGISTRADORES AXI 0x43C00000`,
`ADC / CLOCK / TAXA DE AQUISIÇÃO`, `INICIALIZAÇÃO / O QUE RESTARTA A FONTE`,
`FIM`. Alguns comandos podem imprimir `(erro)` / `n/a` conforme o que existe
na imagem da Red Pitaya — **isso é esperado**; o importante é: SHA-256 do
binário do servidor `:12345`, conteúdo de `fifo.c` (se presente),
`sampling_frequency` do ADC, e os `systemctl cat` dos units.

### Onde a saída deve ser devolvida

Colar/anexar o conteúdo de `/tmp/fpga_inspect.out` e `/tmp/fpga_inspect.err`
na próxima mensagem, ou salvá-los em
`physical-layer/fpga_inspect_out_<data>.txt` /
`physical-layer/fpga_inspect_err_<data>.txt` no repo. A partir daí o item 6
(unidade física) e o item 13 (taxa física) podem ser fechados.

## Roteiro read-only a executar (pelo operador ou sob permissão)

Executar **como `root@10.0.10.2`**, sem escrever em registrador, sem reiniciar
processo, sem recarregar bitstream, sem abrir segundo consumidor, sem
power-cycle. Registrar hashes **antes** de qualquer coisa.

```sh
# ---- identidade e ambiente ----
uname -a; cat /etc/os-release 2>/dev/null | head -5; uptime; date -u
cat /proc/cpuinfo | grep -E 'model name|Hardware|Revision|Serial' | head
free -m; df -h /

# ---- bitstream / FPGA fabric ----
ls -la /opt/redpitaya* /root/*.bit* 2>/dev/null
find / -maxdepth 4 -name '*.bit' -o -name '*.bit.bin' 2>/dev/null
cat /sys/kernel/debug/fpga_manager*/fpga0/state 2>/dev/null
xxd -l 64 /dev/xdevcfg 2>/dev/null || echo "xdevcfg n/a"
md5sum /lib/firmware/*.bit* 2>/dev/null; sha256sum /lib/firmware/*.bit* 2>/dev/null

# ---- o binário/servidor que serve :12345 ----
ss -tlnp | grep 12345 || netstat -tlnp 2>/dev/null | grep 12345
PID=$(fuser 12345/tcp 2>/dev/null | tr -d ' ')
ls -la /proc/$PID/exe; sha256sum "$(readlink -f /proc/$PID/exe)"
cat /proc/$PID/cmdline | tr '\0' ' '; echo
tr '\0' '\n' < /proc/$PID/environ | grep -viE 'pass|secret|key'
# fonte, se presente
find / -maxdepth 4 -name 'fifo.c' -o -name '*.c' -path '*qrng*' 2>/dev/null
for f in $(find / -maxdepth 4 -name 'fifo*.c' 2>/dev/null); do echo "== $f =="; sha256sum "$f"; sed -n '1,200p' "$f"; done

# ---- registradores AXI mapeados (SÓ LEITURA) ----
# devmem NÃO escreve quando chamado sem valor. Ler o bloco 0x43C00000..+0x20
which devmem monitor
for off in 0 4 8 12 16 20 24 28; do
  printf '0x43C000%02x = ' $off
  devmem $((0x43C00000 + off)) 2>/dev/null || echo '(sem devmem)'
done
# NÃO ler 0x43C11000 repetidamente (é o FIFO de dados — leitura consome!).
# Ler UMA vez só o registrador de status/config, se documentado, e anotar.

# ---- ADC / clock ----
dmesg 2>/dev/null | grep -iE 'adc|xadc|sample|clock|pll|si570|adc9' | head -40
cat /sys/bus/iio/devices/iio:device*/name 2>/dev/null
cat /sys/bus/iio/devices/iio:device*/sampling_frequency* 2>/dev/null
cat /sys/bus/iio/devices/iio:device*/in_voltage_sampling_frequency 2>/dev/null

# ---- unidade / largura de palavra / init ----
systemctl cat '*qrng*' '*fifo*' '*rp*' 2>/dev/null
ls -la /etc/systemd/system/ | grep -iE 'qrng|fifo|redpitaya'
crontab -l 2>/dev/null; cat /etc/rc.local 2>/dev/null
```

## Perguntas do item 6 que esta saída responderia

| pergunta | onde a saída acima responde |
|---|---|
| Qual fenômeno físico / onde ocorre a digitização | `dmesg` ADC/XADC, `iio:device*/name`, datasheet do conversor referenciado |
| Largura da amostra física; uint32 é amostra ou agrupamento | fonte de `fifo.c` (`htole32(num)` por leitura), RTL se presente |
| 4 bytes = lanes / word-slices / amostras sucessivas | RTL / comentários em `fifo.c` / registrador de config |
| Contador / padding / cabeçalho / campo determinístico | leitura única dos registradores de status; RTL |
| Condicionamento / XOR / mistura no lado FPGA | RTL; ausência confirmada só no driver C hoje |
| Taxa física de amostragem | `iio:device*/sampling_frequency`, clock/PLL no `dmesg` |
| Throughput = taxa física? | comparar `sampling_frequency` × largura vs. os ~680.626 B/s medidos |
| O que reinicia a noise source | `systemctl cat` dos units, `rc.local`, sequência de reset no RTL/`fifo.c` |

## Proposta EXATA de instrumentação (para a janela do item 9)

Depende do roteiro acima ter identificado quais fronteiras a montante são
acessíveis. Assumindo o pior caso (só o lado Linux é acessível, sem RTL):

| campo | proposta |
|---|---|
| **Ponto** | `tee` de leitura-única no named pipe `/tmp/fifo_qrng` (a fronteira mais a montante sem tocar a FPGA). Se `fifo.c` expuser um modo "echo" ou um segundo FD de debug **documentado**, usar esse em vez do `tee`. |
| **Método** | `mkfifo /tmp/fifo_qrng.tap`; parar `qrng-fifo.service`; iniciar `qrng-connector.py | tee >(cat > /tmp/fifo_qrng.tap) > /tmp/fifo_qrng` num wrapper; `server_api.py` continua lendo `/tmp/fifo_qrng` normalmente; um coletor lê `/tmp/fifo_qrng.tap` com `capture_id` estável e alimenta o `BoundaryCapture` (physical-layer/instrumentation/harness.py). |
| **Duração** | 3–5 min por lote; 5–10 lotes. Montagem+desmontagem do wrapper: < 60 s cada. |
| **Indisponibilidade** | a reinicialização do `qrng-fifo.service` para instalar o wrapper interrompe o stream por ~2–5 s (o `server_api.py` tem `RingBuffer` de 256 MiB que absorve; nenhum cliente vê 503 se o buffer não esvaziar). |
| **Risco** | baixo: `tee` não consome uma segunda sequência (é o MESMO fluxo espelhado); não altera framing; não bloqueia o produtor (pipe tem buffer do kernel + o coletor drena continuamente). Risco real: se o coletor travar, o `tee` bloqueia o pipe e o `server_api.py` para de receber — mitigação: `timeout`/`O_NONBLOCK` no coletor e um watchdog que mata o `tee` e restaura o `ExecStart` original. |
| **Rollback** | `systemctl stop qrng-fifo`; restaurar `ExecStart` original (cópia salva antes); `rm /tmp/fifo_qrng.tap*`; `systemctl start qrng-fifo`; confirmar `total_pushed` voltando a subir no `/health`. |
| **Consumidor único preservado** | o `tee` espelha; `server_api.py` continua o **único** leitor de `/tmp/fifo_qrng`. O coletor lê `/tmp/fifo_qrng.tap`, que é alimentado pelo `tee`, não pela FIFO original. Nenhuma segunda conexão ao `:12345` é aberta. |
| **Prova de que o mesmo bloco atravessou todas as fronteiras** | `capture_id` = SHA-256 dos primeiros 4 KiB do lote, carimbado no momento da captura no `tap`. O mesmo bloco é então buscado em `server_api.py` via `GET /v1/raw?bytes=N` **imediatamente** (offset alinhado por `total_popped`), e comparado byte a byte com o que o `tap` gravou. `BoundaryCapture.hash_table()` mostra se os SHA-256 coincidem de `fifo_c_out`/`tcp_socket` (se acessíveis) até `ring_buffer`. |

**As fronteiras `register_fifo_out`, `fifo_c_out` e `tcp_socket` exigem
instrumentar dentro de `fifo.c` ou fazer sniff do socket `:12345`** — ambos
mexem no caminho produtivo e precisam de autorização adicional específica
(não coberta por "inspeção read-only"). Ver `PHYSICAL_WINDOW_PLAN.md`.
