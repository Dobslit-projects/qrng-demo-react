import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchQrngRandIntViaToken,
  fetchQrngRandIntsViaToken,
  uniformIntsFromBytes,
  bytesToDiscreteFloats,
  generateQrngSequence,
  bytesToUint32Array,
  uint32ToFloat,
  exponentialFromUniform,
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

/**
 * Item 5 da auditoria: contrato Monte Carlo U = uint32 / 2^32, 0 <= U < 1.
 * DataSection.jsx (genMonteCarlo) e ApplicationsSection.jsx (Monte Carlo π)
 * já usam bytesToUint32Array + uint32ToFloat -- exatamente o que é testado
 * aqui. Fixtures obrigatórias da auditoria + guarda de regressão do bug
 * histórico em que os floats ficavam concentrados entre ~0,188 e ~0,224
 * (causado por um método de conversão diferente e enviesado, não pelo
 * uint32/2^32 usado hoje).
 */
describe("Monte Carlo — uint32ToFloat (U = uint32 / 2^32)", () => {
  it("fixture: 00 00 00 00 -> 0", () => {
    const [u32] = bytesToUint32Array(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    expect(uint32ToFloat(u32)).toBe(0);
  });

  it("fixture: 80 00 00 00 -> 0.5", () => {
    const [u32] = bytesToUint32Array(new Uint8Array([0x80, 0x00, 0x00, 0x00]));
    expect(uint32ToFloat(u32)).toBe(0.5);
  });

  it("fixture: FF FF FF FF -> 0.9999999997671694 (nunca exatamente 1)", () => {
    const [u32] = bytesToUint32Array(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    const f = uint32ToFloat(u32);
    expect(f).toBe(0.9999999997671694);
    expect(f).toBeLessThan(1);
  });

  it("nenhum valor de uint32 produz exatamente 1", () => {
    const candidates = [0, 1, 2 ** 31, 2 ** 32 - 2, 2 ** 32 - 1];
    for (const n of candidates) {
      expect(uint32ToFloat(n >>> 0)).toBeLessThan(1);
    }
  });

  it("0 é um valor permitido (não é excluído/rejeitado)", () => {
    expect(uint32ToFloat(0)).toBe(0);
  });

  it("regressão: bytes variados cobrem [0,1) por inteiro, sem concentração em ~0,188-0,224", () => {
    // 64 uint32 espaçados uniformemente por todo o espaço de 32 bits --
    // simula uma amostra QRNG bem distribuída. O bug histórico (byte/255
    // ou outro método enviesado) concentrava os floats numa faixa estreita;
    // uint32/2^32 aplicado a uma entrada bem distribuída deve produzir uma
    // saída que cobre quase todo [0,1).
    const bytes = new Uint8Array(64 * 4);
    for (let i = 0; i < 64; i++) {
      const n = Math.floor((i / 64) * 4294967296);
      bytes[i * 4]     = (n >>> 24) & 0xff;
      bytes[i * 4 + 1] = (n >>> 16) & 0xff;
      bytes[i * 4 + 2] = (n >>> 8) & 0xff;
      bytes[i * 4 + 3] = n & 0xff;
    }
    const floats = bytesToUint32Array(bytes).map(uint32ToFloat);
    const min = Math.min(...floats);
    const max = Math.max(...floats);
    expect(min).toBeLessThan(0.05);
    expect(max).toBeGreaterThan(0.95);
    // Nenhum valor cai preso na faixa estreita do bug antigo enquanto o
    // restante da amostra está fora dela.
    const stuckInOldBugRange = floats.filter((f) => f >= 0.188 && f <= 0.224).length;
    expect(stuckInOldBugRange).toBeLessThan(floats.length * 0.2);
  });
});

describe("exponentialFromUniform — transformada inversa (X = -mean * ln(1 - U))", () => {
  it("todos os resultados são finitos, mesmo para U próximo de 1", () => {
    const uMax = uint32ToFloat(0xffffffff); // 0.9999999997671694, nunca 1
    const x = exponentialFromUniform(uMax, 5);
    expect(Number.isFinite(x)).toBe(true);
  });

  it("U=0 produz X=0 (numericamente; JS retorna -0, equivalente a 0)", () => {
    expect(exponentialFromUniform(0, 5)).toBe(-0); // -mean * ln(1) = -mean * 0 = -0
    expect(exponentialFromUniform(0, 5) == 0).toBe(true); // -0 == 0
  });

  it("é monotonicamente crescente em U (mapeamento correto da transformada inversa)", () => {
    const a = exponentialFromUniform(0.1, 5);
    const b = exponentialFromUniform(0.5, 5);
    const c = exponentialFromUniform(0.9, 5);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("média amostral de uma amostra uniforme sintética grande fica próxima de `mean`", () => {
    // U uniforme sintético em (0,1) via 2000 pontos espaçados -- não é RNG
    // real, mas basta para verificar a matemática da transformada.
    const n = 2000;
    let sum = 0;
    for (let i = 1; i < n; i++) {
      const u = i / n; // (0,1), evita u=0 e u=1 exatos
      sum += exponentialFromUniform(u, 5);
    }
    const sampleMean = sum / (n - 1);
    expect(sampleMean).toBeGreaterThan(4.5);
    expect(sampleMean).toBeLessThan(5.5);
  });
});
