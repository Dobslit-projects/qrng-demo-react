# Busca controlada pelo projeto Vivado / RTL do bitstream de produção

**Data:** 2026-08-29
**Branch:** `investigate/fpga-vivado-artifacts-20260829`
**Alvo:** `/root/stream_app.bit.bin` (2 083 744 bytes) — bitstream carregado em produção pelo `qrng-stream.service`.
**Natureza:** inspeção **somente leitura**. Nenhuma reprogramação, nenhum reboot, nenhum reset da noise source, nenhuma parada de `fifo.c`/TCP, nenhum segundo consumidor do FIFO, **nenhum acesso a `/dev/mem` / MMIO**, nenhuma alteração de arquivo, nenhum deploy, nenhum merge.

> **Nota de relógio.** A FPGA está sem NTP e com RTC dessincronizado: durante a coleta o relógio da placa marcava **2026-03-28** (data real 2026-08-29). Todo timestamp originado da placa (mtime de arquivo, `journalctl`, `systemctl show`) está nesse relógio enviesado e é rotulado como *(relógio da placa)*.

---

## 1. Hosts e diretórios autorizados percorridos

| Host | Acesso | Caminho do repo / raízes percorridas | Sistemas de arquivos físicos |
|---|---|---|---|
| **FPGA** `10.0.10.2` (`rp-f0d1e2`) | SSH multi-hop `local → Bongo → dobslit → FPGA` | `/` (ext4, `/dev/root`), `/boot` = `/opt/redpitaya` (vfat **ro**, `/dev/mmcblk0p1`) | `mmcblk0p1` 484M vfat ro; `mmcblk0p2` 29.2G ext4 rw. **Sem mídia externa, NFS, USB, loopback.** |
| **dobslit** `192.168.0.42` (`ubuntu-dobslit`) | SSH via Bongo reverse-tunnel `:22222` | `/home`, `/root`, `/opt`, `/srv`, `/data`, `/mnt`, `/media`, `/var/lib/docker/volumes`, `/usr/local/src` | `sda2` / ext4; `sda1` /boot/efi vfat. Sem mídia externa. |
| **Bongo** `2.24.117.58` (`srv1692191`) | SSH direto (root) | idem dobslit + `/root/projects/*` (repos), `/root/ci-e2e` | `sda1` / ext4; `sda16` /boot; `sda15` /boot/efi. Sem mídia externa. |
| **repo local** `qrng-demo-react` | working tree + `git log --all` | árvore rastreada inteira + histórico completo | — |

O `git remote origin` do repo local é um **git bundle**, não GitHub; o histórico `--all` do bundle foi varrido.

---

## 2. Comandos executados (resumidos; nenhum grava, nenhum lê `/dev/mem`)

Todos rodaram como payload `sh -s` via `scratchpad/hop.py <target>`. Excluídos do log valores de credenciais/tokens/chaves.

**FPGA — baseline do bitstream (Seção 4):**
```
uname -a; cat /etc/os-release; hostname; cat /proc/uptime
cat /proc/mounts | grep -v <virtuais>;  lsblk
ls -l --time-style=full-iso /root/stream_app.bit.bin /root/dac_test.bit.bin
stat /root/stream_app.bit.bin
sha256sum / sha512sum /root/stream_app.bit.bin
head -c 64 /root/stream_app.bit.bin | xxd        # só cabeçalho, sem dump extenso
strings -n 8 /root/stream_app.bit.bin | head -60 # confirmar ausência de metadados ASCII
ls -l /root/*.bit /root/*.bif /root/*.xsa /root/*.hwh /root/BOOT.BIN ...
cat /sys/class/fpga_manager/fpga0/{name,state,firmware,flags}
ls /sys/kernel/config/device-tree/overlays/Full/ ; cat .../path ; cat .../status
tr -d '\0' < /proc/device-tree/{compatible,model}
python3  # parse dos pacotes de configuração (sync, IDCODE, CTL0, FDRI) — leitura do arquivo, sem MMIO
```

**FPGA — busca de artefatos (Seção 5):**
```
systemctl cat qrng-stream.service ; cat /etc/rc.local ; cat /root/init_demo.sh
grep -RIl 'stream_app.bit.bin|fpgautil|bit.bin' /etc /root /opt/redpitaya/{sbin,bin} /usr/local
find /root /home /mnt /media /srv /var/lib /usr/local/{src,share} /tmp -xdev -type f \
     \( -iname '*.xpr' -o -iname '*.xsa' -o -iname '*.hwh' -o -iname '*.hdf' -o -iname '*.dcp' \
        -o -iname '*.bd' -o -iname '*.v' -o -iname '*.sv' -o -iname '*.vhd' -o -iname '*.vhdl' \
        -o -iname '*.xdc' -o -iname '*.ucf' -o -iname '*.bit' -o -iname '*.bit.bin' -o -iname '*.bif' \
        -o -iname '*.mcs' -o -iname '*.ltx' -o -iname '*.edf' -o -iname '*.edn' -o -iname '*.xci' \
        -o -iname 'vivado*.log' -o -iname 'vivado*.jou' -o -iname '*.tcl' -o -iname '*.dtbo' \) -printf ...
find / -xdev \( -path /proc -o -path /sys -o -path /dev \) -prune -o -type d -name '.git' -print
find <bases> -xdev -type f \( -iname '*.tar*' -o -iname '*.zip' -o -iname '*.gz' -o -iname '*.xz' \)
find /boot /opt/redpitaya -name '*.dtbo'         # não atravessado por -xdev a partir de /
find /opt/redpitaya/fpga -type f \( -name '*.bit' -o -name '*.bit.bin' \) -exec sha256sum {} \;
head -40  /opt/redpitaya/fpga/z20_125_4ch/*/git_info.txt
cat       /opt/redpitaya/fpga/z20_125_4ch/stream_app/dts/{fpga.dts,fpga.dtso,pl.dtsi,pl_patch.dtsi}
head/awk  /root/numbers_*.txt /root/adc_counts_laser_on.txt   # formato e faixa numérica, sem dump
grep -nEi 'vivado|xsct|bootgen|\.xpr|\.tcl|petalinux' /root/.bash_history   # corroboração, não fonte primária
cat /opt/redpitaya/sbin/overlay.sh ; grep -n 'overlay|fpga' /opt/redpitaya/sbin/startup.sh
cat /tmp/loaded_fpga.inf ; /opt/redpitaya/bin/monitor -f
journalctl -b -u qrng-stream.service | head ; systemctl show qrng-stream.service -p ActiveState ...
ps -eo pid,ppid,etimes,cmd | grep -E 'fifo|nc -k|fpgautil'
```

**dobslit e Bongo — mesma varredura** (`find <home/opt/srv/data/docker-volumes> -xdev` para os mesmos sufixos + nomes contendo `vivado|bitstream|stream_app|.runs|.srcs|.gen|.Xil`; `find ... -name .git`; `find / -xdev -name '*.bit*'`).

**repo local:**
```
git ls-files | grep -Ei 'fpga|vivado|\.v$|\.sv$|\.vhd|\.xdc|bitstream|\.bit|hardware|rtl'
git log --all --oneline --diff-filter=A -- '*.bit' '*.bit.bin' '*.v' '*.sv' '*.vhd' '*.xdc' 'fpga/*' 'hardware/*'
git grep -nIi -e 'stream_app.bit' -e '0x43C00000' -e 'vivado' -e 'z20_125_4ch' -- 'physical-layer/*.md'
```

---

## 3. Resultado da busca

### 3.1 Artefatos de projeto Vivado / RTL

| Categoria | FPGA `/` + `/boot` | FPGA `/opt/redpitaya` | dobslit | Bongo | repo + histórico |
|---|---|---|---|---|---|
| `.xpr` (projeto Vivado) | — | — | — | — | — |
| RTL `.v` / `.sv` / `.vhd` / `.vhdl` | — | — | — | — | — |
| Block Design `.bd` / `.bxml` | — | — | — | — | — |
| Constraints `.xdc` / `.ucf` | — | só `.dts/.dtsi` stock RP | — | — | — |
| Checkpoints `.dcp` | — | — | — | — | — |
| Hand-off `.xsa` / `.hwh` / `.hdf` | — | — | — | — | — |
| `vivado.log` / `vivado.jou` / `.Xil` / `.runs` / `.srcs` / `.gen` | — | — | — | — | — |
| Tcl de build (`create_project`, `make_project`) | — | só `overlay.sh`/`mkoverlay.sh` (chamam `fpgautil`) | — | — | — |
| Arquivos `.tar/.zip/.gz/.xz` com fontes | — (só backups dpkg) | — | — | — | — |
| Repositório git do projeto | — (só clones `RedPitaya/jupyter`, `WhirlwindTourOfPython`) | — | — (só `SP800-90B_EntropyAssessment`) | — (só repos de software) | n/a |

**Nenhum artefato de projeto Vivado, RTL, block design, constraints, checkpoint ou hand-off foi encontrado em nenhum host autorizado nem no histórico do repositório.**

### 3.2 Artefatos de hardware que EXISTEM

| Host | Caminho | Tipo | Tamanho | SHA-256 | Data *(relógio da placa)* | Relação com o bitstream | Confiança |
|---|---|---|---|---|---|---|---|
| FPGA | `/root/stream_app.bit.bin` | bitstream raw `.bin` (headerless, palavras byte-swapped) | 2 083 744 | `392a51e6…aa8f4e3e` | mtime 2026-02-11 18:41; birth 2025-10-31 17:13 | **É o alvo** — carregado por `qrng-stream.service` `ExecStartPre` | CONFIRMADA |
| FPGA | `/root/dac_test.bit.bin` | bitstream raw `.bin` | 2 083 744 | `de763e62…f31bc57f` | mtime 2026-02-11 22:06 | Mesmo tamanho; difere em 63 379 B numa única região contígua do FDRI (bytes 249 301–2 081 652); mesmo device/IO. Interpretado como **mesmo projeto, build alternativo (teste de DAC)**. | PROVÁVEL |
| FPGA | `/boot/fpga/**`, `/opt/redpitaya/fpga/**` | árvore FPGA stock Red Pitaya (`.bit`, `.bit.bin`, `.dtbo`, `.dts`, `.dtsi`, `fsbl.elf`, `git_info.txt`) para z10_125, z20_122, z20_125, **z20_125_4ch**, z20_250… variantes `logic`/`barebones`/`v0.94`/`stream_app`/`mercury`/`pyrpl`/`classic`/`axi4lite` | vários | (nenhum `.bit.bin` bate com o alvo — tabela em `FPGA_PROVENANCE.md`) | 2024-08-06/07 | **Baseline pública** para diff/reconstrução; NÃO é a origem do alvo (nenhum hash bate) | CONFIRMADA (que é baseline; que **não** é a origem) |
| FPGA | `/root/numbers_*.txt`, `/root/adc_counts_laser_on.txt`, `/root/testelocal/*` | datasets capturados + servidores FastAPI antigos (software) | vários | — | 2025-11 … 2026-06 | Saídas/experimentos do datapath; não são fonte RTL. Usados como evidência em `FPGA_SAMPLE_UNIT_DECISION.md` | CONFIRMADA (que existem; que não são RTL) |

Estados de "Relação" possíveis: **CONFIRMADA** (hash/manifesto/log de build/script de cópia/commit/equivalência reproduzida), **PROVÁVEL**, **POSSÍVEL**, **SEM RELAÇÃO**, **INCONCLUSIVA**.

### 3.3 Onde o bitstream foi compilado

Não determinável no escopo autorizado. `/root/.bash_history` da FPGA contém apenas `gcc -O3 -g fifo.c -o fifo` (repetido) e builds de kernel/`libiio`/`gpio-utils` — **nenhuma** linha `vivado`, `xsct`, `bootgen`, `.xpr`, `.tcl`, `petalinux`. Zynq-7010 não roda Vivado; o `.bit.bin` foi gerado **fora da placa** e copiado para `/root` (o mecanismo de cópia — `scp`/`sftp` — não aparece no histórico filtrado). O host de build (workstation de desenvolvimento) **não faz parte dos hosts autorizados desta etapa**.

---

## 4. Observações estruturais confirmadas por parsing (somente leitura do arquivo)

- **`IDCODE = 0x03722093` → `xc7z010` (Zynq-7010).** Contradiz "Zynq-7020" da documentação do projeto; concorda com `monitor -f = z10_125`. **Discrepância não resolvida** — ver `FPGA_PROVENANCE.md` §4.
- **`CTL0 = 0x501`, bit ENC (6) = 0 → bitstream não criptografado, sem AES/HMAC.**
- **Sem cabeçalho ASCII `.bit`** → sem nome de design, sem versão de ferramenta, sem data de build, sem UserID embutidos.
- **Configuração FULL** (`FDRI` = 520 352 palavras ≈ 2 081 408 B), não reconfiguração parcial.
- `.bit.bin` = dados de fabric com palavras de 32 bits **byte-swapped** vs `.bit` canônico (convenção Red Pitaya / `fpgautil`/PCAP). Sync `0xAA995566` no offset 48 após de-swap.
- **Overlay de device tree em runtime = `fpga.dtbo` stock** (variante `v0.94`, escolhida por `startup.sh` no boot). O `qrng-stream.service` recarrega **só o fabric** (`fpgautil -b` **sem** `-o`), deixando o overlay stock no lugar. Benigno: `fifo.c` acessa o FIFO por `mmap` de `/dev/mem` em `0x43C00000` (físico cru), **não** por nó UIO/DT. O overlay stock descreve apenas `rp_oscilloscope@0x40000000` e `rp_gpio@0x40200000`; **nada em `0x43C00000`**.

---

## 5. Limitações desta busca

1. **Host de build não acessado** — o projeto Vivado, se existir versionado, está na workstation de quem compilou; fora do escopo autorizado.
2. **Sem readback JTAG / Vivado Hardware Manager** — proibido nesta etapa; o conteúdo lógico do fabric (netlist reversa) não foi extraído.
3. **Relógio da placa enviesado** — datas da placa não são confiáveis para ordenação temporal absoluta.
4. **`file(1)` ausente na placa** — tipo do bitstream determinado por parsing manual dos pacotes de configuração (resultado consistente e inequívoco).
5. **`monitor -f`/IDCODE divergem da documentação** quanto ao device — não reconciliado.
