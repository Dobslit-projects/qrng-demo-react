import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchQRNGRandInt } from "./qrngApi";

/**
 * Regressão do viés de módulo em fetchQRNGRandInt: antes desta correção, a
 * função fazia `n % range` sem rejeição, favorecendo sistematicamente os
 * valores mais baixos da faixa sempre que `range` não dividisse 2^32
 * exatamente (praticamente sempre). Estes testes fixam a resposta do fetch
 * para garantir que (a) um candidato uint32 fora do maior múltiplo de
 * `range` que cabe em 2^32 é REJEITADO e nunca usado para calcular o valor
 * final, e (b) o primeiro candidato aceitável é usado corretamente.
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

describe("fetchQRNGRandInt — rejection sampling (sem viés de módulo)", () => {
  it("rejeita candidatos uint32 acima do maior múltiplo de `range` que cabe em 2^32", async () => {
    // range = 6 (dado 1d6, min=1 max=6): 2^32 = 4294967296, 4294967296 % 6 = 4
    // limit = 4294967296 - 4 = 4294967292. Um candidato >= limit deve ser
    // descartado; o próximo candidato válido deve ser o que efetivamente
    // determina o resultado.
    const range = 6;
    const limit = Math.floor(4294967296 / range) * range; // 4294967292
    const rejected = limit; // exatamente no limite → deve ser rejeitado
    const accepted = 10;    // 10 % 6 = 4 → valor esperado: min(1) + 4 = 5

    const hex = hexOfU32(rejected) + hexOfU32(accepted);
    mockFetchOnce(hex);

    const result = await fetchQRNGRandInt(1, 6);
    expect(result.value).toBe(5);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("usa o primeiro candidato quando ele já está dentro do limite (sem rejeição)", async () => {
    // coin flip: min=0, max=1
    const accepted = 4294967295; // ímpar → 4294967295 % 2 = 1
    mockFetchOnce(hexOfU32(accepted));

    const result = await fetchQRNGRandInt(0, 1);
    expect(result.value).toBe(1);
  });

  it("busca um novo lote de candidatos se todos os 8 do primeiro lote forem rejeitados", async () => {
    const range = 6;
    const limit = Math.floor(4294967296 / range) * range;
    const rejectedBatch = Array.from({ length: 8 }, () => hexOfU32(limit)).join("");
    const acceptedBatch = hexOfU32(6); // 6 % 6 = 0 → valor esperado: min(1) + 0 = 1

    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call += 1;
      return {
        ok: true,
        json: async () => ({ random: call === 1 ? rejectedBatch : acceptedBatch }),
      };
    });

    const result = await fetchQRNGRandInt(1, 6);
    expect(result.value).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejeita faixas inválidas sem chamar a API", async () => {
    globalThis.fetch = vi.fn();
    await expect(fetchQRNGRandInt(10, 5)).rejects.toThrow(/faixa inválida/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
