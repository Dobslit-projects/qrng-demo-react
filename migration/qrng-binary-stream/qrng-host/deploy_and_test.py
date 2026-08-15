#!/usr/bin/env python3
"""
Deploy e teste da migração QRNG: ASCII decimal → uint32-le binary.
Executa em fases — cada uma pode ser interrompida sem afetar a produção
até que a Fase 5 (switch) seja confirmada explicitamente.

Fases:
  1 — preflight: verificar estado atual (passivo, apenas leitura)
  2 — upload: enviar fifo.c e server_api.py para os servidores
  3 — compile: compilar fifo.binary no FPGA (não substitui fifo)
  4 — isolatedtest: testar fifo.binary em processo separado
  5 — switch: substituir fifo + reiniciar qrng-stream (impacto breve)
  6 — deployapi: implantar novo server_api.py + reiniciar qrng-api
  7 — verify: verificação pós-migração (endpoints, stats, saúde)

Uso:
  python deploy_and_test.py [--phase 1-7] [--auto]
  --auto: pula confirmações interativas (use com cuidado nas Fases 5-6)
"""
import sys, os, time, struct, argparse, base64, statistics
import paramiko

# ── Credenciais (ler de variáveis de ambiente — nunca commitar senhas) ─────────
# Defina em .env ou exporte antes de rodar:
#   export QRNG_JUMP_HOST=... QRNG_JUMP_USER=... QRNG_JUMP_PASS=...
#   export QRNG_HOST=...      QRNG_USER=...      QRNG_PASS=...
#   export QRNG_FPGA_HOST=... QRNG_FPGA_USER=... QRNG_FPGA_PASS=...
def _env(key):
    val = os.environ.get(key)
    if not val:
        raise RuntimeError(f"Variável de ambiente obrigatória não definida: {key}")
    return val

JUMP_HOST = _env("QRNG_JUMP_HOST"); JUMP_USER = _env("QRNG_JUMP_USER"); JUMP_PASS = _env("QRNG_JUMP_PASS")
QRNG_HOST = _env("QRNG_HOST");      QRNG_USER = _env("QRNG_USER");      QRNG_PASS = _env("QRNG_PASS")
FPGA_HOST = _env("QRNG_FPGA_HOST"); FPGA_USER = _env("QRNG_FPGA_USER"); FPGA_PASS = _env("QRNG_FPGA_PASS")

# ── Caminhos ──────────────────────────────────────────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATION_FPGA_FIFO_C   = os.path.join(HERE, "..", "fpga", "fifo.c")
MIGRATION_SERVER_API_PY = os.path.join(HERE, "server_api.py")

FPGA_FIFO_C_REMOTE    = "/root/fifo.c"
FPGA_FIFO_OLD         = "/root/fifo.old"
FPGA_FIFO_C_OLD       = "/root/fifo.c.old"
FPGA_FIFO_BINARY      = "/root/fifo.binary"
FPGA_FIFO_PROD        = "/root/fifo"
QRNG_SERVER_API       = "/home/dobslit/qrng-api/server_api.py"
QRNG_SERVER_API_OLD   = "/home/dobslit/qrng-api/server_api.py.old"

# ── SHA-256 esperado do fifo.c atual (pré-migração) ──────────────────────────
EXPECTED_OLD_SHA256 = "8a338ad7534b8474f54392b01f0099f3a08993c4833e549fb3f748e364ef2367"

# ── Conexões SSH ──────────────────────────────────────────────────────────────

def make_client(h, u, p, sock=None):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(h, port=22, username=u, password=p, sock=sock,
              timeout=20, allow_agent=False, look_for_keys=False)
    return c

def hop_channel(client, host):
    return client.get_transport().open_channel("direct-tcpip", (host, 22), ("127.0.0.1", 0))

def run(client, cmd, timeout=30):
    _, o, e = client.exec_command(cmd, timeout=timeout)
    stdout = o.read().decode("utf-8", errors="replace").strip()
    stderr = e.read().decode("utf-8", errors="replace").strip()
    return stdout, stderr

def upload_file(client, local_path, remote_path):
    """Upload via base64 para preservar bytes exatos (funciona por SSH sem scp)."""
    with open(local_path, "rb") as f:
        content = f.read()
    b64 = base64.b64encode(content).decode("ascii")
    cmd = f"echo '{b64}' | base64 -d > {remote_path}"
    out, err = run(client, cmd, timeout=30)
    if err:
        raise RuntimeError(f"Upload {remote_path} error: {err}")
    return len(content)

def sep(title):
    print(f"\n{'─'*64}\n  {title}\n{'─'*64}", flush=True)

def ok(msg):  print(f"  ✓ {msg}", flush=True)
def warn(msg): print(f"  ⚠ {msg}", flush=True)
def fail(msg, exit_code=1):
    print(f"  ✗ {msg}", file=sys.stderr, flush=True)
    sys.exit(exit_code)

def connect_all():
    sep("Estabelecendo conexões SSH")
    jump = make_client(JUMP_HOST, JUMP_USER, JUMP_PASS)
    ok(f"Jump host {JUMP_HOST}")
    qrng = make_client(QRNG_HOST, QRNG_USER, QRNG_PASS, sock=hop_channel(jump, QRNG_HOST))
    ok(f"QRNG host {QRNG_HOST}")
    fpga = make_client(FPGA_HOST, FPGA_USER, FPGA_PASS, sock=hop_channel(qrng, FPGA_HOST))
    ok(f"FPGA {FPGA_HOST}")
    return jump, qrng, fpga

def close_all(jump, qrng, fpga):
    for c in (fpga, qrng, jump):
        try: c.close()
        except: pass

# ── Fase 1: Preflight ─────────────────────────────────────────────────────────

def phase1_preflight(jump, qrng, fpga):
    sep("Fase 1 — Preflight (apenas leitura)")

    # FPGA: verificar SHA-256 de fifo.c atual
    sha, _ = run(fpga, f"sha256sum {FPGA_FIFO_C_REMOTE} 2>/dev/null | awk '{{print $1}}'")
    if sha == EXPECTED_OLD_SHA256:
        ok(f"fifo.c SHA-256 correto (pré-migração): {sha[:16]}…")
    else:
        warn(f"fifo.c SHA-256 INESPERADO: {sha}")
        warn(f"Esperado: {EXPECTED_OLD_SHA256[:16]}…")
        warn("Pode já ter sido modificado. Verifique antes de continuar.")

    # FPGA: estado do serviço
    state, _ = run(fpga, "systemctl show qrng-stream.service -p ActiveState,NRestarts --no-pager")
    ok(f"qrng-stream.service: {state.replace(chr(10), ' ')}")

    # QRNG host: estado dos serviços
    state_q, _ = run(qrng, "systemctl show qrng-api.service qrng-fifo.service -p ActiveState,NRestarts --no-pager")
    ok(f"QRNG host services:\n    {state_q.replace(chr(10), chr(10)+'    ')}")

    # QRNG host: health
    health, _ = run(qrng, "curl -s --max-time 5 http://127.0.0.1:8001/health")
    ok(f"Health: {health[:200]}")

    # QRNG host: amostra atual (verificar que é ASCII)
    sample, _ = run(qrng, "curl -s --max-time 5 'http://127.0.0.1:8001/random?bytes=32'")
    if all(c in '0123456789' for c in sample):
        ok(f"Amostra atual é ASCII decimal: '{sample[:40]}…'")
    else:
        warn(f"Amostra atual NÃO é ASCII puro: {repr(sample[:40])}")

    ok("Preflight concluído.")

# ── Fase 2: Upload ────────────────────────────────────────────────────────────

def phase2_upload(jump, qrng, fpga, auto=False):
    sep("Fase 2 — Upload de arquivos")

    # Backup do fifo.c atual no FPGA
    run(fpga, f"cp {FPGA_FIFO_PROD} {FPGA_FIFO_OLD} 2>/dev/null; "
              f"cp {FPGA_FIFO_C_REMOTE} {FPGA_FIFO_C_OLD} 2>/dev/null")
    ok(f"Backup: {FPGA_FIFO_OLD}, {FPGA_FIFO_C_OLD}")

    # Backup do server_api.py atual no QRNG host
    run(qrng, f"cp {QRNG_SERVER_API} {QRNG_SERVER_API_OLD} 2>/dev/null")
    ok(f"Backup: {QRNG_SERVER_API_OLD}")

    # Upload novo fifo.c para FPGA
    n = upload_file(fpga, MIGRATION_FPGA_FIFO_C, FPGA_FIFO_C_REMOTE)
    sha_new, _ = run(fpga, f"sha256sum {FPGA_FIFO_C_REMOTE} | awk '{{print $1}}'")
    ok(f"fifo.c enviado ({n} bytes), SHA-256: {sha_new[:16]}…")

    # Upload novo server_api.py para QRNG host
    # (NÃO sobrescreve o arquivo em produção ainda — salva com sufixo .new)
    upload_file(qrng, MIGRATION_SERVER_API_PY, f"{QRNG_SERVER_API}.new")
    ok(f"server_api.py.new enviado")

    ok("Upload concluído.")

# ── Fase 3: Compile ───────────────────────────────────────────────────────────

def phase3_compile(jump, qrng, fpga, auto=False):
    sep("Fase 3 — Compilar fifo.binary no FPGA")

    cmd = f"cd /root && gcc -O3 -g -Wall -o {FPGA_FIFO_BINARY} {FPGA_FIFO_C_REMOTE} 2>&1"
    out, _ = run(fpga, cmd, timeout=60)
    if out:
        warn(f"Saída do compilador:\n{out}")
    else:
        ok("Compilação sem warnings")

    # Verificar que o binário existe e tamanho razoável
    ls_out, _ = run(fpga, f"ls -la {FPGA_FIFO_BINARY} 2>/dev/null")
    if FPGA_FIFO_BINARY not in ls_out:
        fail("fifo.binary não encontrado após compilação")
    ok(f"fifo.binary: {ls_out}")

    sha_bin, _ = run(fpga, f"sha256sum {FPGA_FIFO_BINARY} | awk '{{print $1}}'")
    ok(f"SHA-256 fifo.binary: {sha_bin[:16]}…")
    ok("Compilação concluída.")

# ── Fase 4: Isolated test ─────────────────────────────────────────────────────

def phase4_isolated_test(jump, qrng, fpga, auto=False):
    sep("Fase 4 — Teste isolado de fifo.binary")
    print("  Executando fifo.binary por 3s em processo isolado…", flush=True)

    # Redirecionar stderr para /dev/null, capturar 4096 bytes de stdout
    cmd = (
        f"timeout 3 {FPGA_FIFO_BINARY} 2>/dev/null | head -c 4096 | base64 -w0"
    )
    b64_out, _ = run(fpga, cmd, timeout=15)
    if not b64_out:
        fail("Nenhuma saída de fifo.binary — verifique hardware e permissões")

    try:
        raw = base64.b64decode(b64_out)
    except Exception as e:
        fail(f"Erro ao decodificar base64: {e}")

    n_bytes = len(raw)
    ok(f"Recebidos {n_bytes} bytes de fifo.binary")

    # Verificar múltiplo de 4 (framing)
    if n_bytes % 4 != 0:
        warn(f"Bytes recebidos ({n_bytes}) não é múltiplo de 4 — framing inconsistente")
    else:
        ok(f"Framing OK: {n_bytes} bytes = {n_bytes // 4} amostras uint32")

    # Verificar que NÃO é ASCII puro (0x30-0x39)
    ascii_only = all(b in range(0x30, 0x3A) for b in raw)
    if ascii_only:
        fail("Output de fifo.binary ainda é ASCII decimal — a migração não funcionou")
    ok("Output NÃO é ASCII puro (esperado para binary LE)")

    # Verificar distribuição de bytes (deve ser ~uniforme, bit_fraction ≈ 0.5)
    byte_counts = [0] * 256
    for b in raw:
        byte_counts[b] += 1
    n_distinct = sum(1 for c in byte_counts if c > 0)
    bit_fraction = sum(bin(b).count("1") * byte_counts[b] for b in range(256)) / (n_bytes * 8)
    ok(f"Bytes distintos: {n_distinct}/256 (espera-se >> 10)")
    ok(f"bit_fraction: {bit_fraction:.4f} (espera-se ≈ 0.48–0.52, ASCII seria 0.435)")

    if n_distinct < 100:
        warn(f"Apenas {n_distinct} bytes distintos — distribuição suspeita")
    if not (0.40 <= bit_fraction <= 0.60):
        warn(f"bit_fraction {bit_fraction:.4f} fora do intervalo esperado [0.40, 0.60]")

    # Desserializar e verificar uint32 (Phase 23 — framing)
    n_samples = n_bytes // 4
    values = struct.unpack(f"<{n_samples}I", raw[:n_samples * 4])
    mean_val = statistics.mean(values)
    ok(f"Amostras: {n_samples} uint32 LE")
    ok(f"mean: {mean_val:.0f} (espera-se ≈ {2**31:.0f} = 2147483648 para uniforme)")
    ok(f"Primeiros 5 valores: {list(values[:5])}")

    ok("Teste isolado concluído — fifo.binary produz saída binary LE correta.")

# ── Fase 5: Switch production ─────────────────────────────────────────────────

def phase5_switch(jump, qrng, fpga, auto=False):
    sep("Fase 5 — Switch de produção (FPGA)")
    if not auto:
        print("\n  ATENÇÃO: Esta fase substituirá /root/fifo pelo binário novo")
        print("  e reiniciará qrng-stream.service (interrupção breve ~5s).")
        print()
        ans = input("  Confirmar? [s/N] ").strip().lower()
        if ans != "s":
            print("  Abortado pelo usuário.")
            return

    # Copiar fifo.binary para fifo (fifo.old já existe como backup)
    out, err = run(fpga, f"cp {FPGA_FIFO_BINARY} {FPGA_FIFO_PROD} && chmod +x {FPGA_FIFO_PROD}")
    if err:
        fail(f"Erro ao copiar fifo.binary: {err}")
    ok(f"{FPGA_FIFO_BINARY} → {FPGA_FIFO_PROD}")

    # Reiniciar qrng-stream.service
    out, err = run(fpga, "systemctl restart qrng-stream.service 2>&1", timeout=30)
    if err and "WARNING" not in err:
        warn(f"systemctl restart saída: {err}")

    # Aguardar serviço ativo
    time.sleep(5)
    state, _ = run(fpga, "systemctl show qrng-stream.service -p ActiveState,NRestarts --no-pager")
    ok(f"qrng-stream.service após restart: {state.replace(chr(10), ' ')}")

    if "active" not in state.lower():
        fail("qrng-stream.service não está ativo após restart")

    ok("Switch FPGA concluído.")

# ── Fase 6: Deploy API ────────────────────────────────────────────────────────

def phase6_deploy_api(jump, qrng, fpga, auto=False):
    sep("Fase 6 — Deploy do novo server_api.py")
    if not auto:
        print("\n  ATENÇÃO: Esta fase substituirá server_api.py e reiniciará qrng-api.service.")
        ans = input("  Confirmar? [s/N] ").strip().lower()
        if ans != "s":
            print("  Abortado pelo usuário.")
            return

    # Mover .new para produção
    out, err = run(qrng, f"cp {QRNG_SERVER_API}.new {QRNG_SERVER_API}")
    if err:
        fail(f"Erro ao implantar server_api.py: {err}")
    ok(f"server_api.py.new → server_api.py")

    # Reiniciar qrng-api.service
    out, err = run(qrng, "sudo systemctl restart qrng-api.service 2>&1", timeout=30)
    time.sleep(5)

    # Verificar
    state, _ = run(qrng, "systemctl show qrng-api.service -p ActiveState,NRestarts --no-pager")
    ok(f"qrng-api.service: {state.replace(chr(10), ' ')}")

    if "active" not in state.lower():
        fail("qrng-api.service não está ativo após restart")

    ok("Deploy API concluído.")

# ── Fase 7: Verify ────────────────────────────────────────────────────────────

def phase7_verify(jump, qrng, fpga, auto=False):
    sep("Fase 7 — Verificação pós-migração")
    time.sleep(3)  # aguardar API estabilizar

    # Health
    health_raw, _ = run(qrng, "curl -s --max-time 5 http://127.0.0.1:8001/health")
    ok(f"/health: {health_raw[:300]}")

    # Verificar stream_format no health (se nova API já implantada)
    if "uint32-le" in health_raw:
        ok("stream_format=uint32-le confirmado no health")
    else:
        warn("stream_format não encontrado no health (API antiga ainda ativa?)")

    # Amostra via /random?bytes=32 — verificar que é binário
    import base64 as b64lib
    sample_b64, _ = run(qrng,
        "curl -s --max-time 5 'http://127.0.0.1:8001/random?bytes=32' | base64 -w0")
    if sample_b64:
        raw = b64lib.b64decode(sample_b64)
        ascii_only = all(b in range(0x30, 0x3A) for b in raw)
        if ascii_only:
            warn("Amostra /random ainda parece ASCII — verificar se qrng-stream reiniciou")
        else:
            bit_frac = sum(bin(b).count("1") for b in raw) / (len(raw) * 8)
            ok(f"/random?bytes=32: {len(raw)} bytes, bit_fraction={bit_frac:.4f} (binário OK se ≈0.50)")

    # /v1/raw (se nova API ativa)
    raw_b64, _ = run(qrng, "curl -s --max-time 5 'http://127.0.0.1:8001/v1/raw?bytes=32' | base64 -w0")
    if raw_b64:
        raw = b64lib.b64decode(raw_b64)
        ok(f"/v1/raw?bytes=32: {len(raw)} bytes, framing={'OK' if len(raw)%4==0 else 'ERRO'}")
    else:
        warn("/v1/raw não respondeu (nova API implantada?)")

    # /v1/uint32
    uint32_out, _ = run(qrng, "curl -s --max-time 5 'http://127.0.0.1:8001/v1/uint32?count=4'")
    ok(f"/v1/uint32?count=4: {uint32_out[:120]}")

    # NRestarts
    restarts_fpga, _ = run(fpga, "systemctl show qrng-stream.service -p NRestarts --no-pager")
    restarts_qrng, _ = run(qrng, "systemctl show qrng-api.service qrng-fifo.service -p NRestarts --no-pager")
    ok(f"NRestarts FPGA: {restarts_fpga}")
    ok(f"NRestarts QRNG: {restarts_qrng.replace(chr(10), ' | ')}")

    ok("Verificação concluída.")

# ── Main ──────────────────────────────────────────────────────────────────────

PHASES = {
    1: ("preflight",     phase1_preflight),
    2: ("upload",        phase2_upload),
    3: ("compile",       phase3_compile),
    4: ("isolatedtest",  phase4_isolated_test),
    5: ("switch",        phase5_switch),
    6: ("deployapi",     phase6_deploy_api),
    7: ("verify",        phase7_verify),
}

def main():
    parser = argparse.ArgumentParser(description="Deploy QRNG binary migration")
    parser.add_argument("--phase", type=int, choices=PHASES.keys(), default=None,
                        help="Executar apenas esta fase (1-7). Sem flag: executa todas.")
    parser.add_argument("--auto", action="store_true",
                        help="Pular confirmações interativas (fases 5-6 são destrutivas)")
    args = parser.parse_args()

    jump, qrng, fpga = connect_all()
    try:
        if args.phase:
            name, fn = PHASES[args.phase]
            fn(jump, qrng, fpga, auto=args.auto)
        else:
            # Executar todas em sequência; parar antes da 5 para confirmação
            for i in range(1, 8):
                _, fn = PHASES[i]
                fn(jump, qrng, fpga, auto=args.auto)
    finally:
        close_all(jump, qrng, fpga)
        print("\nConexões SSH encerradas.", flush=True)

if __name__ == "__main__":
    main()
