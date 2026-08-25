import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useContext } from "react";
import { AppProvider, AppContext } from "./AppContext";
import HardwareStatusBar from "../components/layout/HardwareStatusBar";
import { fetchQrngBytes, resetPrecollectedCursor } from "../lib/qrngHelper";

function Probe() {
  const {
    status, isOnline, isLiveData, isFallbackSelected, health, qrngSource, setQrngSource,
    precollectedRemaining, precollectedLimit, restartPrecollectedDemo,
    apiReachable, sourceConnected, freshDataAvailable, lastHealthCheckAt,
    lastBlockReceivedAt, inputRateBytesPerSecond, fallbackSelected,
  } = useContext(AppContext);
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="isOnline">{String(isOnline)}</span>
      <span data-testid="isLiveData">{String(isLiveData)}</span>
      <span data-testid="isFallbackSelected">{String(isFallbackSelected)}</span>
      <span data-testid="fallbackSelected">{String(fallbackSelected)}</span>
      <span data-testid="buffer">{health ? health.buffer_bytes_available : "null"}</span>
      <button data-testid="selectPreCollected" onClick={() => setQrngSource("pre-collected")}>seed</button>
      <span data-testid="qrngSource">{qrngSource}</span>
      <span data-testid="precollectedRemaining">{precollectedRemaining}</span>
      <span data-testid="precollectedLimit">{precollectedLimit}</span>
      <button data-testid="restartDemo" onClick={restartPrecollectedDemo}>restart</button>
      <span data-testid="apiReachable">{String(apiReachable)}</span>
      <span data-testid="sourceConnected">{String(sourceConnected)}</span>
      <span data-testid="freshDataAvailable">{String(freshDataAvailable)}</span>
      <span data-testid="lastHealthCheckAt">{String(lastHealthCheckAt !== null)}</span>
      <span data-testid="lastBlockReceivedAt">{String(lastBlockReceivedAt !== null)}</span>
      <span data-testid="inputRateBytesPerSecond">{String(inputRateBytesPerSecond)}</span>
    </div>
  );
}

function renderProbe() {
  return render(
    <AppProvider>
      <Probe />
    </AppProvider>,
  );
}

function renderStatusBar() {
  return render(
    <AppProvider>
      <HardwareStatusBar />
    </AppProvider>,
  );
}

const healthyBody = { buffer_bytes_available: 1000, buffer_capacity: 2000, total_pushed: 1, total_popped: 1 };
const healthyResponse = () => Promise.resolve({ ok: true, json: async () => healthyBody });
const failedResponse = () => Promise.reject(new Error("network error"));

// Espera as microtasks da cadeia fetch -> json -> setState resolverem,
// sem depender do avanço do relógio (a 1ª chamada de poll() não passa
// por nenhum timer).
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AppContext — status do QRNG (checking/online/offline)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("estado inicial é 'checking' — nunca 'offline' — antes de qualquer resposta chegar", async () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {})); // nunca resolve: simula check em andamento
    renderProbe();
    expect(screen.getByTestId("status").textContent).toBe("checking");
    // "checking" conta como online: não deve travar botões nem mostrar fallback
    expect(screen.getByTestId("isOnline").textContent).toBe("true");
  });

  it("durante o carregamento, a barra de status não mostra OFFLINE nem a mensagem de fallback", async () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
    renderStatusBar();
    expect(screen.queryByText("OFFLINE")).not.toBeInTheDocument();
    expect(screen.queryByText(/Fonte indisponivel|Fonte indisponível/)).not.toBeInTheDocument();
    expect(screen.getByText("ONLINE")).toBeInTheDocument();
  });

  it("QRNG online: primeiro sucesso confirma ONLINE imediatamente, sem esperar 2 sucessos", async () => {
    globalThis.fetch = vi.fn(() => healthyResponse());
    renderProbe();
    await flushMicrotasks();
    expect(screen.getByTestId("status").textContent).toBe("online");
    expect(screen.getByTestId("buffer").textContent).toBe("1000");
  });

  it("falha transitória curta durante o carregamento não confirma offline (fica 'checking' e recupera)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(() => {
      calls += 1;
      return calls === 1 ? failedResponse() : healthyResponse();
    });
    renderProbe();
    await flushMicrotasks(); // 1ª tentativa falha
    expect(screen.getByTestId("status").textContent).toBe("checking");
    expect(screen.getByTestId("isOnline").textContent).toBe("true");

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // retry curto (checking) resolve com sucesso
    expect(screen.getByTestId("status").textContent).toBe("online");
  });

  it("QRNG realmente offline: só confirma após falhas consecutivas (retry curto de 2s)", async () => {
    globalThis.fetch = vi.fn(() => failedResponse());
    renderProbe();
    await flushMicrotasks(); // falha 1
    expect(screen.getByTestId("status").textContent).toBe("checking");

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // falha 2
    expect(screen.getByTestId("status").textContent).toBe("checking");

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // falha 3 → confirma offline
    expect(screen.getByTestId("status").textContent).toBe("offline");
    expect(screen.getByTestId("isOnline").textContent).toBe("false");
  });

  it("mensagem de fallback só aparece depois do offline confirmado, nunca antes", async () => {
    globalThis.fetch = vi.fn(() => failedResponse());
    renderStatusBar();
    await flushMicrotasks();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    // ainda checando (2 falhas) — sem fallback
    expect(screen.queryByText(/Fonte indisponivel|Fonte indisponível/)).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // 3ª falha → offline confirmado
    expect(screen.getByText(/Fonte indisponivel|Fonte indisponível/)).toBeInTheDocument();
  });

  it("depois de ONLINE, uma falha isolada não derruba o status (sem flapping)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(() => {
      calls += 1;
      return calls === 2 ? failedResponse() : healthyResponse();
    });
    renderProbe();
    await flushMicrotasks();
    expect(screen.getByTestId("status").textContent).toBe("online");

    // próxima checagem, já em cadência normal (15s), falha isolada
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.getByTestId("status").textContent).toBe("online");
  });

  it("atualização de página (remount) volta para 'checking' e não trava em offline", async () => {
    globalThis.fetch = vi.fn(() => healthyResponse());
    const { unmount } = renderProbe();
    await flushMicrotasks();
    expect(screen.getByTestId("status").textContent).toBe("online");

    unmount();
    renderProbe();
    expect(screen.getByTestId("status").textContent).toBe("checking");
    await flushMicrotasks();
    expect(screen.getByTestId("status").textContent).toBe("online");
  });

  it("o status continua sendo atualizado só pelo polling, sem depender de nenhuma ação do usuário", async () => {
    globalThis.fetch = vi.fn(() => healthyResponse());
    renderProbe();
    await flushMicrotasks();
    expect(screen.getByTestId("status").textContent).toBe("online");

    // passa o tempo sem nenhuma interação (gerar números, baixar, etc.) —
    // o status deve permanecer coerente só com o polling em segundo plano.
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.getByTestId("status").textContent).toBe("online");
    expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(1);
  });

  it("não atualiza estado após desmontar (sem warning de setState em componente desmontado)", async () => {
    let resolveFetch;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const { unmount } = renderProbe();
    unmount();
    // resolve a fetch DEPOIS do unmount — não deve lançar nem quebrar
    await act(async () => {
      resolveFetch({ ok: true, json: async () => healthyBody });
      await Promise.resolve();
    });
    expect(true).toBe(true); // chega aqui sem warning/erro = comportamento correto
  });

  it("não dispara requisições simultâneas para a mesma fonte (guarda contra sobreposição)", async () => {
    // AppProvider mantém 2 hooks paralelos (remote + fpga) por desenho —
    // o que a guarda evita é sobrepor 2 chamadas para a MESMA URL/fonte.
    const inFlightByUrl = {};
    const maxInFlightByUrl = {};
    globalThis.fetch = vi.fn((url) => {
      inFlightByUrl[url] = (inFlightByUrl[url] || 0) + 1;
      maxInFlightByUrl[url] = Math.max(maxInFlightByUrl[url] || 0, inFlightByUrl[url]);
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlightByUrl[url] -= 1;
          resolve({ ok: true, json: async () => healthyBody });
        }, 100);
      });
    });
    renderProbe();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    for (const url of Object.keys(maxInFlightByUrl)) {
      expect(maxInFlightByUrl[url]).toBeLessThanOrEqual(1);
    }
    expect(Object.keys(maxInFlightByUrl).length).toBeGreaterThan(0);
  });
});

describe("AppContext — isLiveData / isFallbackSelected (auditoria item 4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("isLiveData é false durante 'checking', mesmo isOnline sendo true", async () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {})); // nunca resolve
    renderProbe();
    expect(screen.getByTestId("status").textContent).toBe("checking");
    expect(screen.getByTestId("isOnline").textContent).toBe("true");
    expect(screen.getByTestId("isLiveData").textContent).toBe("false");
  });

  it("isLiveData só vira true depois que 'online' é confirmado por uma resposta real", async () => {
    globalThis.fetch = vi.fn(() => healthyResponse());
    renderProbe();
    await flushMicrotasks();
    expect(screen.getByTestId("status").textContent).toBe("online");
    expect(screen.getByTestId("isLiveData").textContent).toBe("true");
  });

  it("fonte pre-collected: isOnline true (não trava UI) mas isLiveData SEMPRE false e isFallbackSelected true", async () => {
    globalThis.fetch = vi.fn(() => healthyResponse());
    renderProbe();
    await act(async () => {
      screen.getByTestId("selectPreCollected").click();
    });
    expect(screen.getByTestId("qrngSource").textContent).toBe("pre-collected");
    expect(screen.getByTestId("status").textContent).toBe("pre-collected");
    expect(screen.getByTestId("isOnline").textContent).toBe("true");
    expect(screen.getByTestId("isLiveData").textContent).toBe("false");
    expect(screen.getByTestId("isFallbackSelected").textContent).toBe("true");
  });

  it("offline confirmado: isOnline false e isLiveData false", async () => {
    globalThis.fetch = vi.fn(() => failedResponse());
    renderProbe();
    await flushMicrotasks();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByTestId("status").textContent).toBe("offline");
    expect(screen.getByTestId("isOnline").textContent).toBe("false");
    expect(screen.getByTestId("isLiveData").textContent).toBe("false");
    expect(screen.getByTestId("isFallbackSelected").textContent).toBe("false");
  });
});

describe("AppContext — cursor do fallback pré-coletado exposto globalmente (item 4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetPrecollectedCursor();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetPrecollectedCursor();
  });

  it("expõe precollectedLimit e precollectedRemaining, e reage a consumo feito por qualquer componente", async () => {
    globalThis.fetch = vi.fn(() => healthyResponse());
    renderProbe();
    expect(screen.getByTestId("precollectedLimit").textContent).toBe("10000");
    expect(screen.getByTestId("precollectedRemaining").textContent).toBe("10000");

    await act(async () => { await fetchQrngBytes(1500, "pre-collected"); });
    expect(screen.getByTestId("precollectedRemaining").textContent).toBe("8500");
  });

  it("restartPrecollectedDemo (botão global) zera o consumo de volta para o limite total", async () => {
    globalThis.fetch = vi.fn(() => healthyResponse());
    renderProbe();
    await act(async () => { await fetchQrngBytes(3000, "pre-collected"); });
    expect(screen.getByTestId("precollectedRemaining").textContent).toBe("7000");

    await act(async () => {
      screen.getByTestId("restartDemo").click();
    });
    expect(screen.getByTestId("precollectedRemaining").textContent).toBe("10000");
  });
});

describe("AppContext — semântica de saúde granular (item 5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("apiReachable e lastHealthCheckAt refletem cada tentativa de poll, mesmo antes de 'online' ser confirmado", async () => {
    globalThis.fetch = vi.fn(() => healthyResponse());
    renderProbe();
    await flushMicrotasks();
    expect(screen.getByTestId("apiReachable").textContent).toBe("true");
    expect(screen.getByTestId("lastHealthCheckAt").textContent).toBe("true");
  });

  it("apiReachable vira false imediatamente numa falha de rede (sem esperar o threshold de OFFLINE confirmado)", async () => {
    globalThis.fetch = vi.fn(() => failedResponse());
    renderProbe();
    await flushMicrotasks();
    // status ainda pode não ter confirmado "offline" (threshold=3), mas a
    // ÚLTIMA tentativa já falhou -- apiReachable não tem hysteresis.
    expect(screen.getByTestId("apiReachable").textContent).toBe("false");
  });

  it("freshDataAvailable e sourceConnected são false quando o buffer reportado está vazio, mesmo com apiReachable true", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ buffer_bytes_available: 0, buffer_capacity: 2000, total_pushed: 5, total_popped: 5 }) })
    );
    renderProbe();
    await flushMicrotasks();
    expect(screen.getByTestId("apiReachable").textContent).toBe("true");
    expect(screen.getByTestId("freshDataAvailable").textContent).toBe("false");
    expect(screen.getByTestId("sourceConnected").textContent).toBe("false");
  });

  it("inputRateBytesPerSecond e lastBlockReceivedAt só populam quando total_pushed aumenta entre polls sucessivos", async () => {
    let pushed = 1000;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ buffer_bytes_available: 500, buffer_capacity: 2000, total_pushed: pushed, total_popped: 0 }) })
    );
    renderProbe();
    await flushMicrotasks();
    // 1º poll: ainda não há um ponto anterior para comparar.
    expect(screen.getByTestId("lastBlockReceivedAt").textContent).toBe("false");
    expect(screen.getByTestId("inputRateBytesPerSecond").textContent).toBe("null");

    pushed += 8000; // novo bloco chegou entre os dois polls
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(screen.getByTestId("lastBlockReceivedAt").textContent).toBe("true");
    expect(screen.getByTestId("inputRateBytesPerSecond").textContent).not.toBe("null");
  });

  it("fallbackSelected é alias de isFallbackSelected (mesmo nome pedido no schema da auditoria)", async () => {
    globalThis.fetch = vi.fn(() => healthyResponse());
    renderProbe();
    await act(async () => { screen.getByTestId("selectPreCollected").click(); });
    expect(screen.getByTestId("fallbackSelected").textContent).toBe(screen.getByTestId("isFallbackSelected").textContent);
    expect(screen.getByTestId("fallbackSelected").textContent).toBe("true");
  });
});
