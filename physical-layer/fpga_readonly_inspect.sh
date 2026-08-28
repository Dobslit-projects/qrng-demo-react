#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Inspeção READ-ONLY da FPGA (Red Pitaya, 10.0.10.2) — fase item 8/9.
#
# NÃO escreve em registrador. NÃO reinicia serviço. NÃO altera arquivo.
# NÃO recarrega bitstream. NÃO abre segundo consumidor. NÃO faz power-cycle.
# Só LÊ. Cada comando é idempotente e sem efeito colateral.
#
# COMO USAR (o operador executa NA FPGA, como root@10.0.10.2):
#   1. copie este arquivo para a FPGA (scp / cole num editor);
#   2. confira o hash:   sha256sum fpga_readonly_inspect.sh
#      esperado:         <PREENCHER — ver physical-layer/FPGA_INSPECTION.md>
#   3. rode:             sh fpga_readonly_inspect.sh > /tmp/fpga_inspect.out 2> /tmp/fpga_inspect.err
#   4. devolva os DOIS arquivos (/tmp/fpga_inspect.out e /tmp/fpga_inspect.err)
#      para quem pediu a inspeção.
# ─────────────────────────────────────────────────────────────────────────────
set -u
sec() { printf '\n===== %s =====\n' "$1"; }

sec "META"
date -u 2>/dev/null; id 2>/dev/null; hostname 2>/dev/null; uname -a 2>/dev/null
cat /etc/os-release 2>/dev/null | head -5
uptime 2>/dev/null

sec "HARDWARE / SOC"
grep -E 'model name|Hardware|Revision|Serial|Features' /proc/cpuinfo 2>/dev/null | head
free -m 2>/dev/null; df -h / 2>/dev/null
cat /sys/firmware/devicetree/base/model 2>/dev/null; echo

sec "BITSTREAM / FPGA FABRIC (só leitura)"
ls -la /opt/redpitaya* 2>/dev/null
find / -maxdepth 5 \( -name '*.bit' -o -name '*.bit.bin' -o -name 'fpga*.bin' \) 2>/dev/null
cat /sys/class/fpga_manager/fpga0/state 2>/dev/null
cat /sys/kernel/debug/fpga_manager*/fpga0/state 2>/dev/null
for f in /lib/firmware/*.bit* /lib/firmware/*fpga* ; do [ -e "$f" ] && sha256sum "$f" 2>/dev/null; done
ls -la /dev/xdevcfg /dev/mem 2>/dev/null

sec "SERVIDOR TCP :12345 (o que o connector consome)"
( ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null ) | grep -E ':12345|:1234[0-9]'
PID=$( (fuser 12345/tcp 2>/dev/null || ss -tlnp 2>/dev/null | grep 12345) | grep -oE '[0-9]+' | head -1 )
if [ -n "${PID:-}" ]; then
  echo "PID=$PID"
  ls -la /proc/$PID/exe 2>/dev/null
  EXE=$(readlink -f /proc/$PID/exe 2>/dev/null); [ -n "$EXE" ] && sha256sum "$EXE" 2>/dev/null
  tr '\0' ' ' < /proc/$PID/cmdline 2>/dev/null; echo
  tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep -viE 'pass|secret|key|token'
  cat /proc/$PID/status 2>/dev/null | grep -E 'Name|State|Threads'
fi

sec "FONTE fifo.c / RTL (se presente no filesystem)"
for f in $(find / -maxdepth 5 \( -name 'fifo*.c' -o -name '*qrng*.c' -o -name '*.vhd' -o -name '*.v' \) 2>/dev/null | head -20); do
  echo "-- $f --"; sha256sum "$f" 2>/dev/null; sed -n '1,120p' "$f" 2>/dev/null
done

sec "REGISTRADORES AXI 0x43C00000 (LEITURA ÚNICA — NÃO ler o FIFO de dados)"
# 0x43C00000..0x43C0001C: leitura de config/status. NÃO ler 0x43C11000 (FIFO out — consome!).
command -v devmem 2>/dev/null; command -v monitor 2>/dev/null
if command -v devmem >/dev/null 2>&1; then
  for off in 0 4 8 12 16 24 28; do
    A=$((0x43C00000 + off)); printf '0x%08X = ' "$A"; devmem "$A" 2>/dev/null || echo '(erro)'
  done
elif command -v monitor >/dev/null 2>&1; then
  for off in 0 4 8 12 16 24 28; do
    A=$((0x43C00000 + off)); printf '0x%08X = ' "$A"; monitor "$A" 2>/dev/null || echo '(erro)'
  done
else
  echo '(nem devmem nem monitor disponíveis — pular)'
fi

sec "ADC / CLOCK / TAXA DE AQUISIÇÃO"
dmesg 2>/dev/null | grep -iE 'adc|xadc|sample|clock|pll|si570|si5351|rf.?clk|acq' | head -40
for d in /sys/bus/iio/devices/iio:device*; do
  [ -e "$d" ] || continue
  echo "-- $d --"; cat "$d/name" 2>/dev/null
  for k in sampling_frequency in_voltage_sampling_frequency sampling_frequency_available; do
    [ -e "$d/$k" ] && printf '%s=' "$k" && cat "$d/$k" 2>/dev/null
  done
done
cat /sys/kernel/debug/clk/clk_summary 2>/dev/null | grep -iE 'adc|fclk|pll' | head

sec "INICIALIZAÇÃO / O QUE RESTARTA A FONTE"
( systemctl list-units --type=service 2>/dev/null | grep -iE 'qrng|fifo|redpitaya|rp_|acq' ) || true
for u in $(systemctl list-unit-files 2>/dev/null | grep -iE 'qrng|fifo|redpitaya' | awk '{print $1}'); do
  echo "-- $u --"; systemctl cat "$u" 2>/dev/null
done
cat /etc/rc.local 2>/dev/null
crontab -l 2>/dev/null
ls -la /etc/systemd/system/ 2>/dev/null | grep -iE 'qrng|fifo|redpitaya'

sec "FIM"
echo "inspeção read-only concluída."
