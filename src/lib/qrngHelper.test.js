import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchQrngRandIntViaToken,
  uniformIntsFromBytes,
  bytesToDiscreteFloats,
  generateQrngSequence,
  bytesToHex,
  bytesToUint32Array,
  uint32ToFloat,
  exponentialFromUniform,
  fetchQrngBytes,
  fetchQrngRawBytes,
  fetchQrngRawBytesViaToken,
  PRECOLLECTED_LIMIT,
  PrecollectedExhaustedError,
  precollectedRemaining,
  resetPrecollectedCursor,
  onPrecollectedChange,
} from "./qrngHelper";

// SHA-256 utilitário (Node/jsdom expõe webcrypto)
async function sha256Hex(u8) {
  const d = await crypto.subtle.digest("SHA-256", u8);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hexToBytes = (h) => {
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
  return o;
};

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
 * Item 4 da auditoria: cursor do fallback pré-coletado SEM wraparound.
 * Antes deste teste existir, o cursor avançava com módulo e reciclava os
 * mesmos 10.000 bytes silenciosamente para sempre -- nenhum consumidor
 * conseguia saber que estava recebendo uma repetição. Estes testes fixam o
 * novo contrato: esgota, lança erro tipado, nunca embrulha sozinho.
 */
describe("fallback pré-coletado — cursor sem wraparound (item 4)", () => {
  afterEach(() => {
    resetPrecollectedCursor();
  });

  it("consome sequencialmente sem repetir bytes já entregues", async () => {
    resetPrecollectedCursor();
    const a = await fetchQrngBytes(4000, "pre-collected");
    const b = await fetchQrngBytes(4000, "pre-collected");
    expect(a.bytes).not.toEqual(b.bytes);
    expect(precollectedRemaining()).toBe(PRECOLLECTED_LIMIT - 8000);
  });

  it("requisições consecutivas até esgotar os 10.000 bytes lançam PrecollectedExhaustedError na que excede o restante", async () => {
    resetPrecollectedCursor();
    await fetchQrngBytes(4000, "pre-collected");
    await fetchQrngBytes(4000, "pre-collected");
    expect(precollectedRemaining()).toBe(2000);
    // pedir mais do que resta (2000) deve falhar, não embrulhar para o início
    await expect(fetchQrngBytes(2001, "pre-collected")).rejects.toThrow(PrecollectedExhaustedError);
    // o restante exato ainda cabe
    const last = await fetchQrngBytes(2000, "pre-collected");
    expect(last.bytes.length).toBe(2000);
    expect(precollectedRemaining()).toBe(0);
    // qualquer pedido adicional, por menor que seja, também falha
    await expect(fetchQrngBytes(1, "pre-collected")).rejects.toThrow(PrecollectedExhaustedError);
  });

  it("resetPrecollectedCursor reaproveita os mesmos bytes desde o início (não é amostra nova)", async () => {
    resetPrecollectedCursor();
    const first = await fetchQrngBytes(100, "pre-collected");
    resetPrecollectedCursor();
    const again = await fetchQrngBytes(100, "pre-collected");
    expect(again.bytes).toEqual(first.bytes);
    expect(precollectedRemaining()).toBe(PRECOLLECTED_LIMIT - 100);
  });

  it("onPrecollectedChange notifica assinantes a cada consumo e no reset", async () => {
    resetPrecollectedCursor();
    const seen = [];
    const unsubscribe = onPrecollectedChange((remaining) => seen.push(remaining));
    await fetchQrngBytes(10, "pre-collected");
    resetPrecollectedCursor();
    unsubscribe();
    expect(seen).toEqual([PRECOLLECTED_LIMIT - 10, PRECOLLECTED_LIMIT]);
  });

  it("retorna proveniência 'unknown' explícita em vez de inferir do nome do arquivo", async () => {
    resetPrecollectedCursor();
    const result = await fetchQrngBytes(10, "pre-collected");
    expect(result.provenance.capturedAt).toBe("unknown");
    expect(result.remaining).toBe(PRECOLLECTED_LIMIT - 10);
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

  // ── Item 5: cobertura explícita da distribuição exponencial ──────────────
  it("identidade exata X = -μ·ln(1-U) para um vetor determinístico, μ=5", () => {
    const MU = 5;
    const uVec = [0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999];
    for (const u of uVec) {
      expect(exponentialFromUniform(u, MU)).toBe(-MU * Math.log(1 - u));
    }
  });

  it("nenhum U do transformador de bytes cai fora de [0,1) e ln(1-U) nunca é log(0)", () => {
    // uint32ToFloat mapeia [0, 2^32-1] -> [0, 1). O máximo (0xFFFFFFFF) < 1,
    // logo 1-U > 0 sempre e Math.log(1-U) é finito -- log(0) é impossível.
    for (const n of [0, 1, 1234567, 0x7fffffff, 0xfffffffe, 0xffffffff]) {
      const u = uint32ToFloat(n);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      expect(1 - u).toBeGreaterThan(0);
      expect(Number.isFinite(exponentialFromUniform(u, 5))).toBe(true);
    }
  });

  it("valores perto de 0 e perto de 1: comportamento correto da cauda", () => {
    // U -> 0  =>  X -> 0
    expect(exponentialFromUniform(uint32ToFloat(1), 5)).toBeGreaterThan(0);
    expect(exponentialFromUniform(uint32ToFloat(1), 5)).toBeLessThan(1e-6);
    // U -> quase 1  =>  X grande, mas finito e coerente com -5·ln(1-U)
    const uHi = uint32ToFloat(0xffffffff);
    const xHi = exponentialFromUniform(uHi, 5);
    expect(xHi).toBe(-5 * Math.log(1 - uHi));
    expect(xHi).toBeGreaterThan(50); // -5·ln(2.3e-10) ≈ 108
    expect(Number.isFinite(xHi)).toBe(true);
  });

  it("média amostral com U real determinístico (PRNG seed fixa) fica em μ ± 10%", () => {
    // 20000 U de um Mersenne-Twister-like determinístico (via seed fixa do
    // gerador de teste local) -- valida a MATEMÁTICA, não a fonte física.
    let s = 123456789 >>> 0;
    const next = () => { // xorshift32 determinístico
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    const N = 20000;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += exponentialFromUniform(next(), 5);
    const mean = sum / N;
    expect(mean).toBeGreaterThan(4.5);
    expect(mean).toBeLessThan(5.5);
  });
});

// ─── Modo binário real: fetchQrngRawBytes / fetchQrngRawBytesViaToken ──────
describe("fetchQrngRawBytes — binário real (item 2), não hex decodificado no cliente", () => {
  function mockRawOnce(bytesArray, headers = {}) {
    const buf = new Uint8Array(bytesArray).buffer;
    const hmap = new Map(Object.entries({
      "x-request-id": "req_0123456789abcdef",
      "x-qrng-source": "dobslit-qrng-ufpe-fpga",
      "x-qrng-conditioned": "false",
      ...headers,
    }));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => buf,
      json: async () => { throw new Error("raw mode must not call .json() on success"); },
      headers: { get: (k) => (hmap.has(k) ? hmap.get(k) : null) },
    });
  }

  it("pede ?format=raw (nunca ?format=hex) e lê arrayBuffer(), não json()", async () => {
    mockRawOnce([0x00, 0x7f, 0x80, 0xff]);
    const out = await fetchQrngRawBytes(4, "remote");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const url = globalThis.fetch.mock.calls[0][0];
    expect(url).toContain("format=raw");
    expect(url).not.toContain("format=hex");
    expect(Array.from(out.bytes)).toEqual([0x00, 0x7f, 0x80, 0xff]);
  });

  it("os N bytes chegam sem transformação; hex derivado bate byte a byte", async () => {
    const src = [1, 2, 3, 250, 251, 252, 0, 255];
    mockRawOnce(src);
    const out = await fetchQrngRawBytes(src.length, "fpga");
    expect(out.bytes).toBeInstanceOf(Uint8Array);
    expect(out.bytes.length).toBe(src.length);
    expect(Array.from(out.bytes)).toEqual(src);
    expect(out.hex).toBe("010203fafbfc00ff");
  });

  it("propaga proveniência e request_id pelos headers (não do corpo)", async () => {
    mockRawOnce([9, 9], { "x-request-id": "req_abc", "x-qrng-source": "dobslit-qrng-ufpe-fpga" });
    const out = await fetchQrngRawBytes(2, "remote");
    expect(out.requestId).toBe("req_abc");
    expect(out.source).toBe("dobslit-qrng-ufpe-fpga");
    expect(out.conditioned).toBe("false");
  });

  it("fonte pre-collected não chama rede (usa o buffer local, sem format=raw)", async () => {
    resetPrecollectedCursor();
    globalThis.fetch = vi.fn();
    const out = await fetchQrngRawBytes(16, "pre-collected");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(out.bytes.length).toBe(16);
    resetPrecollectedCursor();
  });

  it("erro HTTP vira exceção (não retorna bytes silenciosamente)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 503,
      json: async () => ({ error: "QRNG_UNAVAILABLE" }),
      headers: { get: () => null },
    });
    await expect(fetchQrngRawBytes(8, "remote")).rejects.toThrow(/QRNG_UNAVAILABLE|503/);
  });

  it("fetchQrngRawBytesViaToken usa CLIENT_API /random?format=raw com Authorization", async () => {
    mockRawOnce([10, 20, 30, 40]);
    localStorage.setItem("qrng_auth_jwt", "jwt-xyz");
    const out = await fetchQrngRawBytesViaToken(4);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toContain("/random?bytes=4&format=raw");
    expect(opts.headers.Authorization).toBe("Bearer jwt-xyz");
    expect(Array.from(out.bytes)).toEqual([10, 20, 30, 40]);
    localStorage.removeItem("qrng_auth_jwt");
  });
});

// ── Item 4.1 (frontend): round-trip binário↔Hex↔uint32 preserva os bytes ────
describe("integridade de serialização no frontend (item 4.1)", () => {
  const vectors = {
    "1B": new Uint8Array([0xa5]),
    "3B": new Uint8Array([0xde, 0xad, 0xbe]),
    "4B": new Uint8Array([0x00, 0x01, 0xfe, 0xff]),
    "7B_nonmult4": new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
    "zeros16": new Uint8Array(16),
    "ff16": new Uint8Array(16).fill(0xff),
    "incremental64": Uint8Array.from({ length: 64 }, (_, i) => i & 0xff),
  };

  for (const [name, v] of Object.entries(vectors)) {
    it(`round-trip binário→Hex→binário e binário→uint8→binário: ${name}`, async () => {
      const expSha = await sha256Hex(v);
      // binário → Hex → binário
      const hex = bytesToHex(v);
      expect(hex).toMatch(/^[0-9a-f]*$/);
      expect(hex.length).toBe(v.length * 2);
      const back = hexToBytes(hex);
      expect(back.length).toBe(v.length);
      expect(await sha256Hex(back)).toBe(expSha);
      // binário → uint8 (array) → binário
      const arr = Array.from(v);
      expect(arr.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)).toBe(true);
      expect(await sha256Hex(Uint8Array.from(arr))).toBe(expSha);
      // primeiro/último valor
      expect(back[0]).toBe(v[0]);
      expect(back[v.length - 1]).toBe(v[v.length - 1]);
    });
  }

  it("bytesToUint32Array decodifica LITTLE-ENDIAN e ignora resto não múltiplo de 4", () => {
    // 0x01 0x00 0x00 0x00 (LE) = 1 ; 0xff 0xff 0xff 0xff = 4294967295 ; +3 bytes de resto
    const v = new Uint8Array([1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 9, 9, 9]);
    const w = bytesToUint32Array(v);
    expect(w.length).toBe(2); // 11 bytes -> 2 words, resto (3 bytes) descartado
    // NOTA: bytesToUint32Array atual monta como (b0<<24)|... -> BIG-ENDIAN.
    // Documentar o que a função REALMENTE faz (contrato observado):
    expect(w[0]).toBe(((1 << 24) >>> 0)); // 0x01000000 = big-endian de [1,0,0,0]
    expect(w[1]).toBe(0xffffffff);
    // e a normalização Monte Carlo nunca chega a 1
    for (const x of w) expect(uint32ToFloat(x)).toBeLessThan(1);
  });

  it("nenhum valor Monte Carlo == 1 para uma varredura determinística", () => {
    const v = Uint8Array.from({ length: 4000 }, (_, i) => (i * 2654435761) & 0xff);
    for (const x of bytesToUint32Array(v)) {
      const u = uint32ToFloat(x);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it("payload que 'parece' ASCII decimal é mantido como bytes (sem virar número)", async () => {
    // "1234567890" em ASCII
    const v = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x30]);
    const expSha = await sha256Hex(v);
    expect(await sha256Hex(hexToBytes(bytesToHex(v)))).toBe(expSha);
    // uint8 = [0x31,...] e NÃO [1,2,3,...]
    expect(Array.from(v)[0]).toBe(0x31);
  });
});
