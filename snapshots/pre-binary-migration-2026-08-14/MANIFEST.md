# QRNG Pre-Migration Snapshot
## Estado estável antes da migração para serialização binária

**Data:** 2026-08-14  
**Objetivo:** Checkpoint de rollback para a migração ASCII → uint32 LE binary  
**Sistema:** bongo.dobslit.com ONLINE · FPGA ONLINE · buffer=256 MB · NRestarts=0

---

## SHA-256 dos arquivos capturados

| Arquivo local | Arquivo remoto | SHA-256 |
|---|---|---|
| `fpga/fifo.c` | FPGA `/root/fifo.c` | `8a338ad7534b8474f54392b01f0099f3a08993c4833e549fb3f748e364ef2367` |
| `fpga/qrng-stream.service` | FPGA `/etc/systemd/system/qrng-stream.service` | `de5c0358a85bd5e424d3cffb15e9d83723109749c597d87ff698df22159b79d4` |
| `qrng-host/qrng-connector.py` | QRNG host `/home/dobslit/qrng-connector.py` | `4ed0b591a8d65e2b331e6eea68eb01741ccf125112f0c857a146cc5f832d0a21` |
| `qrng-host/server_api.py` | QRNG host `/home/dobslit/qrng-api/server_api.py` | `e789d6ecbbb9418e3d3d91d60ed4b4c05aabbcbebd5e746f96b6cb355322ab09` |
| `qrng-host/qrng-api.service` | QRNG host `/etc/systemd/system/qrng-api.service` | `3bd729800693cb21e2441b0c83cde78e62e39cc5dde755b920baa7c34fab5336` |
| `qrng-host/qrng-fifo.service` | QRNG host `/etc/systemd/system/qrng-fifo.service` | `eb0a4a0f4ca4948c310c9a3a43c1b09a8fed4adec9011b3e0e8af370f65ed282` |

> **Executável FPGA** `/root/fifo` (binário compilado, 13108 bytes)  
> SHA-256: `7664da234497c2b96fb90baadf8d2c5796826bcfe6833ac77c26912efae6e390`  
> *(Não incluído nesta snapshot — compilar novamente com `gcc -O3 -g fifo.c -o fifo` a partir de `fpga/fifo.c`)*

---

## Estado do sistema no momento do checkpoint

| Componente | Host | Estado | NRestarts | PID |
|---|---|---|---|---|
| qrng-stream.service | FPGA 10.0.10.2 | ACTIVE | 0 | 359 |
| fifo (processo) | FPGA 10.0.10.2 | running | — | 363 |
| nc -k -l :12345 | FPGA 10.0.10.2 | ESTAB | — | 364 |
| qrng-fifo.service | QRNG host 192.168.0.42 | ACTIVE | 0 | 108433 |
| qrng-api.service | QRNG host 192.168.0.42 | ACTIVE | 0 | 108434 |
| Portal público | bongo.dobslit.com | HTTP 200 | — | — |

**Formato TCP atual:** ASCII decimal sem delimitador (`fprintf("%u", num)`)  
**Bytes TCP:** exclusivamente 0x30–0x39  
**Throughput:** ≈6.8 MB/s = 54.6 Mbps  
**Buffer:** 256 MB (cheio)  
**Amostra API:** `2229667817720239` (16 bytes ASCII)

---

## Pipeline atual (a ser substituído)

```
AXI FIFO → uint32 → fprintf("%u") → ASCII stream → nc :12345 → TCP
→ qrng-connector.py (pass-through) → /tmp/fifo_qrng → RingBuffer → API
```

**Conteúdo RingBuffer:** bytes ASCII 0x30–0x39  
**API `/random?bytes=N`:** retorna N bytes ASCII  
**Sem conditioning**

---

## Resultados estatísticos de referência (NÃO alterar)

| Grandeza | Valor | Fonte |
|---|---|---|
| H_min(B) | 6.988 ± 0.025 bits/byte | NIST ea_non_iid, B01/B02/B03 |
| H_min por uint32 | 27.95 bits/uint32 | 6.988 × 4 |
| Classificação | non-IID | Compression Test limitante |
| C_RCT(B) | 4 | derivado de H_min |
| C_APT(B) | ≈21 | derivado de H_min |
| H_iid(C) | 3.078 bits/dígito | Camada C (ASCII) |
| C_RCT(C) | 8 | Auditoria 5.1 |
| C_APT(C) | 103 | Auditoria 5.1 |

---

## Rollback completo — passo a passo

### Rollback do FPGA

```bash
# 1. Verificar que fifo.c desta snapshot é correto
sha256sum fpga/fifo.c
# Esperado: 8a338ad7534b8474f54392b01f0099f3a08993c4833e549fb3f748e364ef2367

# 2. Copiar para o FPGA
scp fpga/fifo.c root@10.0.10.2:/root/fifo.c

# 3. Compilar no FPGA (SSH via jump)
ssh -J root@100.78.196.107 root@192.168.0.42 -W 10.0.10.2:22
# no FPGA:
cd /root
gcc -O3 -g fifo.c -o fifo.new
sha256sum fifo.new  # verificar antes de instalar
mv fifo.new fifo

# 4. Restaurar qrng-stream.service
scp fpga/qrng-stream.service root@10.0.10.2:/etc/systemd/system/qrng-stream.service
ssh root@10.0.10.2 "systemctl daemon-reload && systemctl restart qrng-stream.service"

# 5. Verificar
ssh root@10.0.10.2 "systemctl status qrng-stream.service --no-pager"
```

### Rollback do QRNG host

```bash
# 1. Restaurar connector
scp qrng-host/qrng-connector.py dobslit@192.168.0.42:/home/dobslit/qrng-connector.py

# 2. Restaurar API
scp qrng-host/server_api.py dobslit@192.168.0.42:/home/dobslit/qrng-api/server_api.py

# 3. Restaurar systemd
sudo cp qrng-host/qrng-api.service /etc/systemd/system/qrng-api.service
sudo cp qrng-host/qrng-fifo.service /etc/systemd/system/qrng-fifo.service
sudo systemctl daemon-reload
sudo systemctl restart qrng-api.service qrng-fifo.service

# 4. Verificar
curl http://127.0.0.1:8001/health
```

### Rollback via git tag

```bash
# Clonar a tag de rollback
git checkout qrng-pre-binary-migration-2026-08-14

# Ou restaurar apenas os arquivos de snapshot
git checkout qrng-pre-binary-migration-2026-08-14 -- snapshots/pre-binary-migration-2026-08-14/
```

---

## Verificação de segredos

Antes de commitar, verificação realizada em:
- `fifo.c`: código C puro, sem segredos
- `qrng-stream.service`: apenas ExecStart com `fifo | nc -k -l`, sem segredos
- `qrng-connector.py`: contém IP 10.0.10.2 (rede interna privada), sem token/senha
- `server_api.py`: sem database credentials, sem JWT secrets, sem API keys
- `qrng-api.service`: apenas uvicorn startup, sem segredos
- `qrng-fifo.service`: apenas connector startup, sem segredos

**Nenhum segredo presente nesta snapshot.**
