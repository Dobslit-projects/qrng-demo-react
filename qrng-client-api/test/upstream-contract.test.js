"use strict";

/**
 * Testes de contrato para interpretUpstreamResponse() — o ponto que decide
 * como o corpo da resposta do upstream FPGA (QRNG_UPSTREAM) é interpretado.
 *
 * Cobre exatamente os casos exigidos pela auditoria: Content-Type correto
 * (octet-stream, json), payload binário que por coincidência parece texto
 * decimal ASCII (não pode ser reinterpretado), formato legado de texto
 * decimal desativado por padrão, JSON malformado/schema incorreto, e
 * Content-Type desconhecido — todos devem falhar de forma explícita, nunca
 * por adivinhação silenciosa.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const os   = require("os");
const path = require("path");

process.env.DB_PATH               = path.join(os.tmpdir(), `qrng-test-upstream-${Date.now()}.db`);
process.env.NODE_ENV              = "test";
process.env.JWT_SECRET            = "test-jwt-secret-for-ci";
process.env.ADMIN_EMAIL           = "admin@test.com";
process.env.MAX_BYTES_PER_REQUEST = "1048576";
process.env.DAILY_QUOTA_REQUESTS  = "10000";
process.env.DAILY_QUOTA_BYTES     = "104857600";
// ALLOW_LEGACY_TEXT_UPSTREAM propositalmente NÃO definida aqui — o contrato
// exige que o formato legado fique desativado por padrão.
delete process.env.ALLOW_LEGACY_TEXT_UPSTREAM;

const { interpretUpstreamResponse, UpstreamFormatError } = require("../server");

// ─── application/octet-stream: pass-through estrito, sem sniffing ──────────

describe("interpretUpstreamResponse — application/octet-stream", () => {
  test("bytes binários genuínos são retornados sem alteração", () => {
    const raw = Buffer.from([0xff, 0x50, 0x39, 0x70, 0x9b, 0xfc, 0xfe, 0xdb]);
    const out = interpretUpstreamResponse("application/octet-stream", raw, 8);
    assert.deepEqual(out, raw);
  });

  test("payload que por coincidência é ASCII decimal NÃO é reinterpretado (fixture obrigatória)", () => {
    // Bytes crus que, decodificados como UTF-8, formam uma string de dígitos.
    // O contrato exige: como Content-Type é octet-stream, isso é usado
    // literalmente como bytes (cada caractere ASCII '0'-'9' vira o byte
    // 0x30-0x39), e NUNCA reinterpretado como "12 números decimais".
    const asciiDigits = "123456789012345678901234567890";
    const raw = Buffer.from(asciiDigits, "ascii");
    const out = interpretUpstreamResponse("application/octet-stream", raw, raw.length);
    assert.deepEqual(out, raw);
    // Confirma explicitamente que o resultado É a string ASCII crua (bytes
    // 0x31 0x32 0x33...), não uma lista de valores 0-255 derivados de
    // agrupar dígitos.
    assert.equal(out.toString("ascii"), asciiDigits);
    assert.equal(out.length, asciiDigits.length); // 30 bytes, não 10 "números"
  });

  test("Content-Type com parâmetro de charset ainda é tratado como octet-stream", () => {
    const raw = Buffer.from([1, 2, 3]);
    const out = interpretUpstreamResponse("application/octet-stream; charset=binary", raw, 3);
    assert.deepEqual(out, raw);
  });
});

// ─── application/json: schema explícito ─────────────────────────────────────

describe("interpretUpstreamResponse — application/json", () => {
  test("{ bytes: [...] } decodifica corretamente", () => {
    const raw = Buffer.from(JSON.stringify({ bytes: [10, 20, 255, 0] }));
    const out = interpretUpstreamResponse("application/json", raw, 4);
    assert.deepEqual(out, Buffer.from([10, 20, 255, 0]));
  });

  test("{ hex: '...' } decodifica corretamente", () => {
    const raw = Buffer.from(JSON.stringify({ hex: "0a14ff00" }));
    const out = interpretUpstreamResponse("application/json", raw, 4);
    assert.deepEqual(out, Buffer.from([0x0a, 0x14, 0xff, 0x00]));
  });

  test("{ random: '...' } (alias de hex) decodifica corretamente", () => {
    const raw = Buffer.from(JSON.stringify({ random: "deadbeef" }));
    const out = interpretUpstreamResponse("application/json", raw, 4);
    assert.deepEqual(out, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  });

  test("JSON malformado falha explicitamente (UPSTREAM_INVALID_JSON)", () => {
    const raw = Buffer.from("{not valid json");
    assert.throws(
      () => interpretUpstreamResponse("application/json", raw, 4),
      (err) => err instanceof UpstreamFormatError && err.code === "UPSTREAM_INVALID_JSON"
    );
  });

  test("schema não reconhecido falha explicitamente (UPSTREAM_JSON_SCHEMA_MISMATCH)", () => {
    const raw = Buffer.from(JSON.stringify({ foo: "bar" }));
    assert.throws(
      () => interpretUpstreamResponse("application/json", raw, 4),
      (err) => err instanceof UpstreamFormatError && err.code === "UPSTREAM_JSON_SCHEMA_MISMATCH"
    );
  });

  test("bytes[] com valor fora de [0,255] falha explicitamente", () => {
    const raw = Buffer.from(JSON.stringify({ bytes: [10, 300, 5] }));
    assert.throws(
      () => interpretUpstreamResponse("application/json", raw, 3),
      (err) => err instanceof UpstreamFormatError && err.code === "UPSTREAM_JSON_SCHEMA_MISMATCH"
    );
  });
});

// ─── text/plain (formato legado): desativado por padrão ───────────────────

describe("interpretUpstreamResponse — text/plain (legado, desativado por padrão)", () => {
  test("com ALLOW_LEGACY_TEXT_UPSTREAM não definida, falha mesmo com corpo decimal válido", () => {
    const raw = Buffer.from("10,20,30,40");
    assert.throws(
      () => interpretUpstreamResponse("text/plain", raw, 4),
      (err) => err instanceof UpstreamFormatError && err.code === "UPSTREAM_LEGACY_FORMAT_DISABLED"
    );
  });
});

describe("interpretUpstreamResponse — text/plain (legado, habilitado explicitamente)", () => {
  // ALLOW_LEGACY_TEXT_UPSTREAM é lida uma única vez no module-load — para
  // testar o caminho habilitado, re-requeremos o módulo com a env setada,
  // usando um DB_PATH isolado para não colidir com o require default acima.
  process.env.ALLOW_LEGACY_TEXT_UPSTREAM = "true";
  process.env.DB_PATH = path.join(os.tmpdir(), `qrng-test-upstream-legacy-${Date.now()}.db`);
  delete require.cache[require.resolve("../server")];
  const legacy = require("../server");
  delete process.env.ALLOW_LEGACY_TEXT_UPSTREAM; // não vaza para outros testes/arquivos

  test("decimal separado por vírgula/espaço é aceito quando habilitado", () => {
    const raw = Buffer.from("10,20,30,40");
    const out = legacy.interpretUpstreamResponse("text/plain", raw, 4);
    assert.deepEqual(out, Buffer.from([10, 20, 30, 40]));
  });

  test("dígitos decimais empacotados de 3 em 3 são aceitos quando habilitado", () => {
    // "010255128" → 010, 255, 128
    const raw = Buffer.from("010255128");
    const out = legacy.interpretUpstreamResponse("text/plain", raw, 3);
    assert.deepEqual(out, Buffer.from([10, 255, 128]));
  });

  test("texto que não bate com nenhum padrão decimal falha explicitamente", () => {
    const raw = Buffer.from("não é decimal nem número");
    assert.throws(
      () => legacy.interpretUpstreamResponse("text/plain", raw, 4),
      (err) => err instanceof legacy.UpstreamFormatError && err.code === "UPSTREAM_LEGACY_TEXT_UNPARSEABLE"
    );
  });
});

// ─── Content-Type ausente ou desconhecido ───────────────────────────────────

describe("interpretUpstreamResponse — Content-Type ausente ou não suportado", () => {
  test("Content-Type ausente falha explicitamente (não faz fallback silencioso)", () => {
    const raw = Buffer.from([1, 2, 3, 4]);
    assert.throws(
      () => interpretUpstreamResponse(null, raw, 4),
      (err) => err instanceof UpstreamFormatError && err.code === "UPSTREAM_MISSING_CONTENT_TYPE"
    );
  });

  test("Content-Type desconhecido (ex.: text/html) falha explicitamente", () => {
    const raw = Buffer.from([1, 2, 3, 4]);
    assert.throws(
      () => interpretUpstreamResponse("text/html", raw, 4),
      (err) => err instanceof UpstreamFormatError && err.code === "UPSTREAM_UNSUPPORTED_CONTENT_TYPE"
    );
  });
});
