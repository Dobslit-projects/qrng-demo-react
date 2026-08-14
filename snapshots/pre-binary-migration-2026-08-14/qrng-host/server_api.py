#!/usr/bin/env python3
"""
QRNG Broker API — com resiliência a falhas do produtor.
Mudanças vs original:
  - RingBuffer.pop_timeout(): retorna None em vez de bloquear para sempre
  - RingBuffer.last_push_time + source_status(): rastreia estado da fonte
  - /health: campos source_status e source_stall_seconds (aditivos, sem quebrar compat)
  - /random e /random_hex: retornam 503 quando buffer vazio (sem bloquear)
  - FileTailByteSource.read(): trata OSError (FIFO deletado/recriado)
  - producer(): envolto em try/except com restart interno
"""
import os, time, threading
from fastapi import FastAPI, Query, Response
from fastapi.responses import StreamingResponse, JSONResponse

SOURCE_OFFLINE_THRESHOLD = 5.0   # s desde último push → degraded
SOURCE_OFFLINE_LONG      = 60.0  # s desde último push → offline
POP_TIMEOUT              = 2.0   # s de espera máxima em pop antes de 503

# ---------- FIFO tail reader ----------
class FileTailByteSource:
    def __init__(self, path: str, poll_s: float = 0.5):
        self.path   = path
        self.poll_s = poll_s
        self._fd    = None

    def open(self):
        # Bloqueia até que um escritor abra o FIFO (normal ao iniciar)
        while True:
            try:
                self._fd = open(self.path, "rb", buffering=0)
                return
            except FileNotFoundError:
                time.sleep(self.poll_s)
            except OSError:
                time.sleep(self.poll_s)

    def read(self, n: int) -> bytes:
        """Lê n bytes. Reobre o FIFO em caso de EOF ou erro."""
        while True:
            try:
                data = self._fd.read(n)
                if data:
                    return data
                # EOF — escritor fechou ou FIFO recriado; aguarda novo escritor
                self._close_fd()
                time.sleep(self.poll_s)
                self._reopen()
            except OSError:
                # FIFO foi deletado/recriado ou outro erro de I/O
                self._close_fd()
                time.sleep(self.poll_s)
                self._reopen()

    def _close_fd(self):
        try:
            self._fd.close()
        except Exception:
            pass

    def _reopen(self):
        """Bloqueia até o FIFO existir E ter um escritor."""
        while True:
            try:
                if not os.path.exists(self.path):
                    time.sleep(self.poll_s)
                    continue
                self._fd = open(self.path, "rb", buffering=0)
                return
            except (FileNotFoundError, OSError):
                time.sleep(self.poll_s)

# ---------- Ring buffer ----------
class RingBuffer:
    def __init__(self, capacity: int):
        self.buf            = bytearray(capacity)
        self.capacity       = capacity
        self.head           = self.tail = self.size = 0
        self.lock           = threading.Lock()
        self.not_empty      = threading.Condition(self.lock)
        self.total_pushed   = 0
        self.total_popped   = 0
        self.last_push_time = 0.0   # timestamp Unix do último push

    def push(self, data: bytes):
        with self.lock:
            if len(data) > self.capacity:
                data = data[-self.capacity:]
            while self.size + len(data) > self.capacity:
                drop = min(self.size, (self.size + len(data)) - self.capacity)
                self.tail = (self.tail + drop) % self.capacity
                self.size -= drop
            first = min(len(data), self.capacity - self.head)
            self.buf[self.head:self.head + first] = data[:first]
            second = len(data) - first
            if second:
                self.buf[0:second] = data[first:]
            self.head = (self.head + len(data)) % self.capacity
            self.size += len(data)
            self.total_pushed += len(data)
            self.last_push_time = time.time()
            self.not_empty.notify_all()

    def pop(self, n: int) -> bytes:
        """Bloqueia até ter n bytes disponíveis (usado pelo /stream)."""
        with self.not_empty:
            while self.size < n:
                self.not_empty.wait()
            return self._read_n(n)

    def pop_timeout(self, n: int, timeout: float):
        """
        Tenta retirar n bytes em até `timeout` segundos.
        Retorna bytes se disponível, None se timeout expirouantes de ter dados.
        """
        deadline = time.time() + timeout
        with self.not_empty:
            while self.size < n:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None
                self.not_empty.wait(timeout=remaining)
                if self.size >= n:
                    break
            if self.size < n:
                return None
            return self._read_n(n)

    def _read_n(self, n: int) -> bytes:
        out = bytearray(n)
        first = min(n, self.capacity - self.tail)
        out[:first] = self.buf[self.tail:self.tail + first]
        second = n - first
        if second:
            out[first:] = self.buf[0:second]
        self.tail   = (self.tail + n) % self.capacity
        self.size   -= n
        self.total_popped += n
        return bytes(out)

    def source_status(self) -> str:
        """online / degraded / offline — baseado em tempo desde último push."""
        if self.total_pushed == 0:
            return "offline"
        stall = time.time() - self.last_push_time
        if stall < SOURCE_OFFLINE_THRESHOLD:
            return "online"
        if stall < SOURCE_OFFLINE_LONG:
            return "degraded"
        return "offline"

# ---------- Producer ----------
def producer(src: FileTailByteSource, rb: RingBuffer, chunk: int = 1 << 20):
    """Thread de ingestão — robusto a erros do FIFO/fonte."""
    while True:
        try:
            src.open()
            while True:
                data = src.read(chunk)
                rb.push(data)
        except Exception:
            # Fechar fd corrompido e aguardar antes de reabrir
            src._close_fd()
            time.sleep(1)

# ---------- App ----------
SOURCE_FILE = "/tmp/fifo_qrng"

rb  = RingBuffer(capacity=256 * 1024 * 1024)
src = FileTailByteSource(SOURCE_FILE)
threading.Thread(target=producer, args=(src, rb), daemon=True).start()

app = FastAPI(title="QRNG Broker API")

@app.get("/health")
def health():
    with rb.lock:
        size = rb.size
        tp   = rb.total_pushed
        pop  = rb.total_popped
        lpt  = rb.last_push_time
    stall = round(time.time() - lpt, 1) if lpt > 0 else None
    return {
        # Campos originais — sem alteração de nomes/tipos (compatibilidade)
        "buffer_bytes_available": size,
        "buffer_capacity":        rb.capacity,
        "total_pushed":           tp,
        "total_popped":           pop,
        "source_file":            SOURCE_FILE,
        # Campos novos (aditivos)
        "source_status":          rb.source_status(),
        "source_stall_seconds":   stall,
    }

@app.get("/random")
def get_random(
    bytes:  int = Query(1024, ge=1, le=50 * 1024 * 1024),
    format: str = Query("binary"),
):
    data = rb.pop_timeout(bytes, timeout=POP_TIMEOUT)
    if data is None:
        return JSONResponse(
            status_code=503,
            content={
                "error":                  "QRNG source temporarily unavailable",
                "source_status":          rb.source_status(),
                "buffer_bytes_available": rb.size,
            }
        )
    if format == "hex":
        return JSONResponse({
            "random":    data.hex(),
            "hex":       data.hex(),
            "bytes":     len(data),
            "source":    "fpga",
            "generator": "Dobslit QRNG / Red Pitaya FPGA",
        })
    return Response(content=data, media_type="application/octet-stream")

@app.get("/random_hex")
def get_random_hex(bytes: int = Query(32, ge=1, le=50 * 1024 * 1024)):
    data = rb.pop_timeout(bytes, timeout=POP_TIMEOUT)
    if data is None:
        return JSONResponse(
            status_code=503,
            content={
                "error":                  "QRNG source temporarily unavailable",
                "buffer_bytes_available": rb.size,
            }
        )
    return JSONResponse({"bytes": len(data), "hex": data.hex()})

@app.get("/stream")
def stream():
    def gen():
        while True:
            yield rb.pop(1 << 20)
    return StreamingResponse(gen(), media_type="application/octet-stream")
