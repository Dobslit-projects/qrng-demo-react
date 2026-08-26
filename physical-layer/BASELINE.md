# Baseline dos componentes realmente executados (dobslit VM / FPGA)

**Commit: "baseline do componente realmente executado"** — este diretório é a
PRIMEIRA vez que `server_api.py`, `qrng-connector.py`, o `nist_service.py`
realmente em produção, os units `systemd` e a configuração `nginx` do host
Bongo entram em qualquer controle de versão. Cada arquivo aqui é uma cópia
byte a byte do que estava rodando em 2026-08-26 — **não** a versão corrigida
que já existe em `qrng-nist-api/nist_service.py` (commit `65fb43b`). O diff
entre as duas está em `nist_service.py.diff-baseline-vs-65fb43b.txt`, gerado
DEPOIS deste commit, nunca usado para substituir o baseline.

## Metadados capturados em 2026-08-26 (antes de qualquer edição)

| Componente | Caminho no host | Tamanho | SHA-256 | mtime | PID | Usuário | Porta | Unidade |
|---|---|---|---|---|---|---|---|---|
| server_api.py | `/home/dobslit/qrng-api/server_api.py` | 10.916 B | `892a4cb44d461f6c71f71e29711da248b758e5bb6ad16b2f35066107e350dead` | 2026-08-15 15:42 | 116644 | dobslit | 127.0.0.1:8001 | `qrng-api.service` |
| qrng-connector.py | `/home/dobslit/qrng-connector.py` | 1.693 B | `4ed0b591a8d65e2b331e6eea68eb01741ccf125112f0c857a146cc5f832d0a21` | 2026-08-14 01:55 | 136746 | dobslit | n/a (escreve em FIFO nomeado) | `qrng-fifo.service` |
| nist_service.py (RODANDO) | `/home/dobslit/qrng-nist-api/nist_service.py` | 21.090 B | `e396675f1b2d9ae7eef6031f40c3c78aa6b6c6224664a62c7701c1e6e4015f2e` | **2026-06-29 22:37** | 82972 | dobslit | 127.0.0.1:8002 | `qrng-nist-api.service` |
| nginx (host Bongo) | `/etc/nginx/sites-available/bongo.dobslit.com` | — | ver commit `f058f22`-era (já inclui os itens 6/8 da rodada anterior) | 2026-08-25 (última edição desta auditoria) | — | root | 80/443 | systemd `nginx.service` (não capturado nesta rodada, presumido padrão Debian/Ubuntu) |

**fifo.c (FPGA)**: NÃO recapturado nesta rodada. O host FPGA (`10.0.10.2`,
Red Pitaya, uptime de 27min observado na rodada anterior) tornou-se
inalcançável via SSH nesta sessão -- TCP connect e ICMP ping bem-sucedidos
(`nc -zv` confirma a porta 22 aberta), mas o handshake SSH nunca completa
("Error reading SSH protocol banner") em 3 tentativas consecutivas com
timeout de 30s cada, através da mesma cadeia de saltos (Proxmox→dobslit→FPGA)
usada com sucesso na rodada anterior. Isto é registrado como um achado
operacional real, não escondido -- ver seção de limitações do relatório
final. O conteúdo de `fifo.c` documentado no pacote técnico da rodada
anterior (mmap do registrador AXI FIFO em `0x43C00000+0x11000`, escrita de
`htole32(num)` por amostra, sem condicionamento) permanece a evidência mais
recente disponível, mas não pôde ser re-hasheado nesta sessão.

## Dependências (venv realmente usado)

Ver `requirements-qrng-api.txt`, capturado via `pip freeze` no
`/home/dobslit/qrng-api/venv` real. Python 3.14.4. Este venv é compartilhado
por `server_api.py` (uvicorn) e `nist_service.py` -- confirmado pelo
`ExecStart` idêntico apontando para o mesmo interpretador em
`qrng-api.service` e `qrng-nist-api.service`.

## Topologia real de inicialização (não documentada em nenhum repositório antes)

```
qrng-fifo.service   (Before=qrng-api.service)
  ExecStart: python3 qrng-connector.py > /tmp/fifo_qrng (named pipe)
  ↓
qrng-api.service    (After=qrng-fifo.service, Wants=qrng-fifo.service)
  ExecStart: uvicorn server_api:app --host 127.0.0.1 --port 8001
  ↓
qrng-tunnel-newvm.service  (After=qrng-api.service)
  SSH reverse tunnel: 127.0.0.1:18001→8001, 127.0.0.1:18002→8002,
  127.0.0.1:22222→22, para root@2.24.117.58 (Bongo VM)
  ↓
qrng-nist-api.service (independente, After=network.target apenas --
  SEM dependência formal de qrng-api.service, apesar de consumir arquivos
  que presumivelmente vêm do mesmo pipeline -- lacuna de modelagem de
  dependência real no systemd, não introduzida por esta auditoria)
```

Todos os 4 units têm `Restart=always` -- um crash de qualquer componente
se recupera sozinho, mas sem alertar ninguém além do log do `journalctl`
(nenhuma métrica de restart-count é exposta hoje).

`start_qrng.sh` (`/home/dobslit/start_qrng.sh`) é um script legado, anterior
aos units `systemd` atuais (linhas de ativação do uvicorn comentadas) --
mantido no host mas não é o mecanismo de start real hoje. Preservado aqui
como `start_qrng.sh.LEGACY_NOT_USED` para não perder o histórico.
