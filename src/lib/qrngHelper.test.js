import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchQrngRandIntViaToken,
  fetchQrngRandIntsViaToken,
  uniformIntsFromBytes,
  bytesToDiscreteFloats,
  generateQrngSequence,
} from "./qrngHelper";

/**
 * Regressão do viés de módulo (item 3/5 da auditoria do pipeline QRNG).
 * Estes testes viviam em src/qrngApi.test.js, testando fetchQRNGRandInt
 * (removida dali e consolidada aqui como fetchQrngRandIntViaToken, junto
 * com o restante do adaptador canônico de bytes QRNG).
 */

function hexOfU32(n) {
  return n.toString(16).padStart(8, "0");
}

function mockFetchOnce(hex) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ random: hex }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchQrngRandIntViaToken — rejection sampling (sem viés de módulo)", () => {
  it("rejeita candidatos uint32 acima do maior múltiplo de `range` que cabe em 2^32", async () => {
    const range = 6;
    const limit = Math.floor(4294967296 / range) * range; // 4294967292
    const rejected = limit;
    const accepted = 10; // 10 % 6 = 4 -> valor esperado: min(1) + 4 = 5

    mockFetchOnce(hexOfU32(rejected) + hexOfU32(accepted));

    const result = await fetchQrngRandIntViaToken(1, 6);
    expect(result.value).toBe(5);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("usa o primeiro candidato quando ele já está dentro do limite (sem rejeição)", async () => {
    const accepted = 4294967295; // ímpar -> 4294967295 % 2 = 1
    mockFetchOnce(hexOfU32(accepted));

    const result = await fetchQrngRandIntViaToken(0, 1);
    expect(result.value).toBe(1);
  });

  it("busca um novo lote de candidatos se todos os 8 do primeiro lote forem rejeitados", async () => {
    const range = 6;
    const limit = Math.floor(4294967296 / range) * range;
    const rejectedBatch = Array.from({ length: 8 }, () => hexOfU32(limit)).join("");
    const acceptedBatch = hexOfU32(6); // 6 % 6 = 0 -> valor esperado: min(1) + 0 = 1

    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call += 1;
      return { ok: true, json: async () => ({ random: call === 1 ? rejectedBatch : acceptedBatch }) };
    });

    const result = await fetchQrngRandIntViaToken(1, 6);
    expect(result.value).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejeita faixas inválidas sem chamar a API", async () => {
    globalThis.fetch = vi.fn();
    await expect(fetchQrngRandIntViaToken(10, 5)).rejects.toThrow(/faixa inválida/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("uniformIntsFromBytes — múltiplos inteiros sem viés (substitui 'byte % range')", () => {
  it("não usa o padrão antigo 'byte % 100', que favorecia 0-55 sobre 56-99", () => {
    // 256 bytes 0..255: com "byte % 100", os bytes 0,100,200 mapeiam para 0
    // (3 ocorrências), enquanto 56 só teria 1 ocorrência (156) -- viés real.
    // Com rejection sampling em blocos de 4 bytes, cada candidato uint32 tem
    // a mesma probabilidade dentro do limite; aqui só verificamos que a
    // função consome 4 bytes por saída (não 1) e produz valores em [0,99].
    const bytes = new Uint8Array(4 * 5);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) % 256;
    const values = uniformIntsFromBytes(bytes, 0, 99, 5);
    expect(values.length).toBe(5);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(99);
    }
  });

  it("retorna menos que `count` se não houver bytes suficientes", () => {
    const bytes = new Uint8Array(4); // só 1 candidato possível
    const values = uniformIntsFromBytes(bytes, 0, 99, 5);
    expect(values.length).toBeLessThanOrEqual(1);
  });
});

describe("bytesToDiscreteFloats — normalização explícita de 256 níveis", () => {
  it("mapeia 0x00 -> 0 e 0xFF -> 1 (não confundir com uint32/2^32 do Monte Carlo)", () => {
    const [a, b] = bytesToDiscreteFloats(new Uint8Array([0x00, 0xff]));
    expect(a).toBe(0);
    expect(b).toBe(1);
  });
});

describe("generateQrngSequence — sem fallback silencioso em caso de erro", () => {
  it("propaga o erro em vez de substituir invisivelmente por dados pré-coletados", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "QRNG_UNAVAILABLE" }),
    });
    await expect(generateQrngSequence(10, "remote")).rejects.toThrow();
  });

  it("fonte pre-collected não chama rede e retorna floats de 256 níveis rotulados corretamente", async () => {
    globalThis.fetch = vi.fn();
    const result = await generateQrngSequence(5, "pre-collected");
    expect(result.source).toBe("pre-collected");
    expect(result.values.length).toBe(5);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
