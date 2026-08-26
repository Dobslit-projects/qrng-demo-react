#!/usr/bin/env python3
"""
QRNG Connector — loop de reconexão interno com backoff exponencial.
Não sai em caso de falha; reconecta automaticamente.
Isso evita que qrng-fifo.service precise reiniciar (e recriar o FIFO).
"""
import socket, sys, time

HOST      = '10.0.10.2'
PORT      = 12345
CHUNK     = 65536
RETRY_MIN = 2    # segundos mínimos de espera entre tentativas
RETRY_MAX = 30   # segundos máximos de espera

backoff = RETRY_MIN

while True:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET,  socket.SO_KEEPALIVE,   1)
    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE,  10)
    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL,  5)
    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT,    3)
    s.settimeout(10)   # timeout de conexão
    try:
        s.connect((HOST, PORT))
        print(f'[qrng-connector] conectado a {HOST}:{PORT}', file=sys.stderr, flush=True)
        backoff = RETRY_MIN   # reset após conexão bem-sucedida
        s.settimeout(60)      # timeout de recebimento
        while True:
            data = s.recv(CHUNK)
            if not data:
                print('[qrng-connector] EOF — FPGA fechou conexão', file=sys.stderr, flush=True)
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    except Exception as e:
        print(f'[qrng-connector] erro: {e}', file=sys.stderr, flush=True)
    finally:
        try:
            s.close()
        except Exception:
            pass
    print(f'[qrng-connector] reconectando em {backoff}s...', file=sys.stderr, flush=True)
    time.sleep(backoff)
    backoff = min(backoff * 2, RETRY_MAX)
