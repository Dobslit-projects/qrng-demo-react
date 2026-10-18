"use strict";

/**
 * QRNG Open API (/v1/capabilities, /v1/entropy, /v1/healthtest) — contrato, validação, bytes, falhas, saúde,
 * concorrência e ausência de entropia nos logs.
 *
 * O broker é um servidor HTTP FALSO, só deste teste (nunca há caminho de simulação no código de produção). Ele serve
 * um fluxo DETERMINÍSTICO e DESTRUTIVO, como o ring buffer real: o byte na posição i do fluxo é o byte (i mod 4) da
 * palavra big-endian uint32 de número floor(i/4). Cada /random retira a próxima região. Assim dá para provar que nenhuma
 * região é entregue duas vezes e que os bytes chegam intactos depois do Base64 — sem usar "ausência de repetição"
 * como critério estatístico.
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http   = require("http");
const os     = require("os");
const fs     = require("fs");
const path   = require("path");

// ── broker FALSO (somente teste) ─────────────────────────────────────────────
function streamBytes(start, n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const pos = start + i;
    b[i] = ((Math.floor(pos / 4) >>> 0) >>> (8 * (3 - (pos % 4)))) & 0xff;
  }
  return b;
}
const fake = {
  pos: 0, pops: [], mode: "normal", randomHeaders: {}, health: null, healthStatus: 200,
  reset() { this.mode = "normal"; this.randomHeaders = {}; this.healthStatus = 200; this.health = healthyJson(); },
};
function healthyJson(over = {}) {
  return {
    source_status: "online", source_stall_seconds: 0, conditioned: true,
    qualification_status: "verified_active_bitstream",
    qualification: {
      schema: "kapua/source-qualification/1", status: "FORMAL_OPERATIONAL_FINAL",
      bitstream_sha256: "86e5947fcac710794d205162543451ab3ca98d952c7b206212e6431609f9d111",
      health_profile_detail: { name: "HEALTH_PROFILE_F", rct_cutoff: 85, apt_window: 1024, apt_cutoff: 793, alpha: "2^-50" },
      H_original_formal: 0.8725, h_out_pre_restart_bits_per_128: 107.13, restart_validated: false,
      sp80090b_full_validation: false, cryptographic_source_ready: false, limitations: ["pre-restart values"],
    },
    entropy_health: "hw_health_tests_passing",
    entropy_health_detail: { probed_at_epoch: Date.now() / 1000 - 30, age_s: 30, wrapper_state: "HEALTHY", fail_flags: [],
                             health_test_flags: [], source: "FPGA wrapper registers, read-only" },
    ...over,
  };
}
const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/health") {
    res.writeHead(fake.healthStatus, { "content-type": "application/json" });
    return res.end(JSON.stringify(fake.health));
  }
  if (u.pathname !== "/random") { res.writeHead(404); return res.end(); }
  const n = Number(u.searchParams.get("bytes"));
  if (fake.mode === "timeout") return; // nunca responde dentro do timeout da API
  if (fake.mode === "error503" || fake.mode === "error500") {
    res.writeHead(fake.mode === "error503" ? 503 : 500, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "QRNG source temporarily unavailable" }));
  }
  if (fake.mode === "badtype") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>"); }
  const give = fake.mode === "short" ? Math.max(0, n - 4) : n;
  const body = streamBytes(fake.pos, give);
  fake.pops.push([fake.pos, give]);
  fake.pos += give;
  res.writeHead(200, {
    "content-type": "application/octet-stream", "content-length": String(body.length),
    "x-qrng-conditioned": "true", "x-qrng-qualification-status": "verified_active_bitstream",
    "x-qrng-bitstream-sha256": "86e5947fcac710794d205162543451ab3ca98d952c7b206212e6431609f9d111",
    "x-qrng-entropy-health": "hw_health_tests_passing", "x-qrng-source-status": "online",
    "x-qrng-received-at": new Date().toISOString(),
    ...fake.randomHeaders,
  });
  res.end(body);
});

const testDbPath = path.join(os.tmpdir(), `qrng-openapi-${Date.now()}.db`);
let app, db, agent, checkUpstream, tokenA;

async function newToken(tag) {
  const reg = await agent.post("/v1/auth/register").send({ email: `qoa-${tag}-${Date.now()}@qa.invalid`, password: "pw-abcdefgh12" });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const tok = await agent.post("/v1/tokens").set("Authorization", `Bearer ${reg.body.token}`);
  assert.equal(tok.status, 200);
  return tok.body.token;
}
const post = (body, tok = tokenA) => agent.post("/v1/entropy").set("Authorization", `Bearer ${tok}`).send(body);

before(async () => {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  fake.reset();
  Object.assign(process.env, {
    DB_PATH: testDbPath, NODE_ENV: "test", JWT_SECRET: "test-jwt-secret-for-ci",
    QRNG_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    MAX_BYTES_PER_REQUEST: "4096", QRNG_OPENAPI_MAX_BLOCK_COUNT: "16",
    QRNG_OPENAPI_STATUS_TTL_MS: "0",
    // 400 ms era apertado demais: com 30 requisições simultâneas e o bcrypt do cadastro ocupando o
    // processo, respostas legítimas do broker falso passavam do prazo e falhas consecutivas marcavam a
    // fonte como parada (falhas aleatórias em cascata). Só o teste de logs usa o modo "timeout".
    QRNG_REQUEST_TIMEOUT_MS: "3000",
    DAILY_QUOTA_REQUESTS: "100000", DAILY_QUOTA_BYTES: String(64 * 1024 * 1024),
    RATE_LIMIT_PER_TOKEN_PER_MINUTE: "100000", RATE_LIMIT_PER_IP_PER_MINUTE: "100000",
  });
  ({ app, db, checkUpstream } = require("../server"));
  agent = require("supertest")(app);
  tokenA = await newToken("a");
});
after(() => {
  upstream.close();
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(testDbPath); } catch (_) {}
});
beforeEach(() => fake.reset());

// ── /capabilities ────────────────────────────────────────────────────────────
describe("GET /v1/capabilities", () => {
  test("campos obrigatórios do contrato, limites da configuração em execução e restrição do total por extensão", async () => {
    const r = await agent.get("/v1/capabilities").set("Authorization", `Bearer ${tokenA}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    const e = r.body.entropy;
    assert.deepEqual([e.min_block_size, e.max_block_size, e.min_block_count, e.max_block_count], [1, 4096, 1, 16]);
    assert.deepEqual(e.entropy_types, ["kuapoa_qrng"]);
    const lim = e.extensions.find((x) => x.name === "kuapoa.limits");
    assert.equal(lim.data.max_total_bytes, 4096);
    assert.equal(lim.data.combinations_above_total_allowed, false);
    assert.ok(e.max_block_size * e.max_block_count > lim.data.max_total_bytes, "o caso que exige a extensão está presente");
    assert.equal(r.body.healthtest.source_count, 1);
    for (const t of r.body.healthtest.test_threshold) {
      assert.ok(t.test_type && !Number.isNaN(Date.parse(t.time_stamp)));
    }
    assert.ok(e.extensions.find((x) => x.name === "kuapoa.contract").data.revision.startsWith("812e2055"));
    assert.ok(!JSON.stringify(r.body).match(/rate_bytes|throughput|mb\/s/i), "nenhuma taxa de produção é anunciada");
  });

  test("os limites anunciados são aceitos e aplicados por /entropy", async () => {
    const c = (await agent.get("/v1/capabilities").set("Authorization", `Bearer ${tokenA}`)).body.entropy;
    const tot = c.extensions.find((x) => x.name === "kuapoa.limits").data.max_total_bytes;
    assert.equal((await post({ block_size: c.max_block_size })).status, 200);
    assert.equal((await post({ block_size: c.min_block_size, block_count: c.max_block_count })).status, 200);
    assert.equal((await post({ block_size: tot / c.max_block_count, block_count: c.max_block_count })).status, 200);
    assert.equal((await post({ block_size: c.max_block_size + 1 })).body.error, "BLOCK_SIZE_OUT_OF_RANGE");
    assert.equal((await post({ block_size: 1, block_count: c.max_block_count + 1 })).body.error, "BLOCK_COUNT_OUT_OF_RANGE");
    assert.equal((await post({ block_size: tot / c.max_block_count + 1, block_count: c.max_block_count })).body.error, "TOTAL_TOO_LARGE");
  });

  test("fonte parada ou broker inacessível → 503 (contrato)", async () => {
    fake.health = healthyJson({ source_status: "offline", source_stall_seconds: 120 });
    const r = await agent.get("/v1/capabilities").set("Authorization", `Bearer ${tokenA}`);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "SOURCE_OFFLINE");
    fake.healthStatus = 500;
    const r2 = await agent.get("/v1/capabilities").set("Authorization", `Bearer ${tokenA}`);
    assert.equal(r2.status, 503);
    assert.equal(r2.body.error, "QRNG_UNAVAILABLE");
    assert.equal(r2.headers["cache-control"], "no-store");
  });
});

// ── /entropy: valores padrão, parâmetros, tipos ──────────────────────────────
describe("POST /v1/entropy — parâmetros", () => {
  test("padrões: block_count=1 e entropy_type = 1º anunciado", async () => {
    const r = await post({ block_size: 32 });
    assert.equal(r.status, 200);
    assert.equal(r.body.entropy.length, 1);
    assert.equal(Buffer.from(r.body.entropy[0], "base64").length, 32);
    const x = r.body.extensions.find((e) => e.name === "kuapoa.response").data;
    assert.equal(x.entropy_type, "kuapoa_qrng");
    assert.equal(x.block_count, 1);
  });

  test("tipos aceitos e rejeitados", async () => {
    assert.equal((await post({ block_size: 8, entropy_type: "kuapoa_qrng" })).status, 200);
    for (const t of ["raw", "KUAPOA_QRNG", "", 1, null, ["kuapoa_qrng"]]) {
      const r = await post({ block_size: 8, entropy_type: t });
      assert.equal(r.status, 422, `entropy_type ${JSON.stringify(t)}`);
      assert.equal(r.body.error, "UNSUPPORTED_ENTROPY_TYPE");
    }
  });

  test("inteiros estritos: sem strings, booleanos, nulos, frações, zero, negativos ou valores inseguros", async () => {
    const bad = ["32", true, false, null, 32.5, 0, -1, 2 ** 53, 1e300, [32], { n: 32 }];
    for (const v of bad) {
      const before = fake.pops.length;
      const r1 = await post({ block_size: v });
      assert.equal(r1.status, 422, `block_size ${JSON.stringify(v)}`);
      const r2 = await post({ block_size: 8, block_count: v });
      assert.equal(r2.status, 422, `block_count ${JSON.stringify(v)}`);
      assert.equal(fake.pops.length, before, "nenhuma entropia consumida antes de validar");
    }
    const r = await post({});
    assert.equal(r.body.error, "MISSING_BLOCK_SIZE");
  });

  test("corpo: não-objeto → 422, sem JSON → 415, JSON malformado → 400, campos desconhecidos ignorados", async () => {
    assert.equal((await post([1, 2])).status, 422);
    const t = await agent.post("/v1/entropy").set("Authorization", `Bearer ${tokenA}`).set("Content-Type", "text/plain").send("block_size=32");
    assert.equal(t.status, 415);
    const m = await agent.post("/v1/entropy").set("Authorization", `Bearer ${tokenA}`).set("Content-Type", "application/json").send("{\"block_size\":");
    assert.equal(m.status, 400);
    assert.equal((await post({ block_size: 4, vendor_hint: "x" })).status, 200);
  });

  test("método errado → 405 com Allow", async () => {
    const r = await agent.get("/v1/entropy").set("Authorization", `Bearer ${tokenA}`);
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, "POST");
    const r2 = await agent.post("/v1/capabilities").set("Authorization", `Bearer ${tokenA}`);
    assert.equal(r2.status, 405);
    assert.equal(r2.headers.allow, "GET");
  });
});

// ── /entropy: bytes ──────────────────────────────────────────────────────────
describe("POST /v1/entropy — bytes", () => {
  test("blocos com o tamanho exato e bytes preservados pelo Base64 (fluxo determinístico)", async () => {
    const start = fake.pos;
    const r = await post({ block_size: 24, block_count: 5 });
    assert.equal(r.status, 200);
    assert.equal(r.body.entropy.length, 5);
    const decoded = r.body.entropy.map((b) => Buffer.from(b, "base64"));
    for (const d of decoded) assert.equal(d.length, 24);
    assert.deepEqual(Buffer.concat(decoded), streamBytes(start, 120), "blocos = região contínua do fluxo, na ordem");
    assert.deepEqual(fake.pops.at(-1), [start, 120], "uma única retirada de exatamente block_size × block_count");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.ok(r.headers["x-request-id"]);
  });

  test("proveniência e qualificação na extensão e nos cabeçalhos", async () => {
    const r = await post({ block_size: 16 });
    const x = r.body.extensions.find((e) => e.name === "kuapoa.response").data;
    assert.equal(x.request_id, r.headers["x-request-id"]);
    assert.equal(x.conditioned, true);
    assert.equal(x.qualification_status, "verified_active_bitstream");
    assert.equal(r.headers["x-qrng-conditioned"], "true");
    assert.equal(x.total_bytes, 16);
  });

  test("bitstream não qualificado: nada é afirmado como condicionado", async () => {
    fake.randomHeaders = { "x-qrng-qualification-status": "unverified_stale_probe", "x-qrng-bitstream-sha256": "" };
    const r = await post({ block_size: 16 });
    assert.equal(r.status, 200);
    const x = r.body.extensions.find((e) => e.name === "kuapoa.response").data;
    assert.equal(x.conditioned, false);
    assert.equal(x.qualification_status, "unverified_stale_probe");
    assert.equal(x.bitstream_sha256, null);
    assert.equal(r.headers["x-qrng-conditioned"], "false");
  });
});

// ── /entropy: falhas da fonte ────────────────────────────────────────────────
describe("POST /v1/entropy — falhas (nunca há sucesso com blocos incompletos)", () => {
  const cases = [
    ["short", 503, "INSUFFICIENT_ENTROPY"],
    ["timeout", 503, "QRNG_UNAVAILABLE"],
    ["error503", 503, "QRNG_UNAVAILABLE"],
    ["error500", 502, "UPSTREAM_ERROR"],
    ["badtype", 502, "UPSTREAM_UNSUPPORTED_CONTENT_TYPE"],
  ];
  for (const [mode, status, code] of cases) {
    test(`broker em modo ${mode} → ${status} ${code}, sem campo entropy`, async () => {
      fake.mode = mode;
      const r = await post({ block_size: 32, block_count: 2 });
      assert.equal(r.status, status);
      assert.equal(r.body.error, code);
      assert.equal(r.body.entropy, undefined);
      assert.equal(r.headers["cache-control"], "no-store");
    });
  }

  test("fonte parada (monitor de 60 s) → 503 SOURCE_OFFLINE antes de consumir", async () => {
    fake.health = healthyJson({ source_status: "offline", source_stall_seconds: 90 });
    await checkUpstream();
    const before = fake.pops.length;
    const r = await post({ block_size: 32 });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "SOURCE_OFFLINE");
    assert.equal(fake.pops.length, before);
    fake.reset();
    await checkUpstream();
    assert.equal((await post({ block_size: 32 })).status, 200);
  });
});

// ── /healthtest ──────────────────────────────────────────────────────────────
describe("GET /v1/healthtest", () => {
  const get = () => agent.get("/v1/healthtest").set("Authorization", `Bearer ${tokenA}`);
  const hw = (b) => b.test_result.find((t) => t.test_type === "kuapoa_hw_continuous_rct_apt");

  test("passing com o instante da observação da sonda (não o da resposta)", async () => {
    const probed = Math.floor(Date.now() / 1000) - 42;
    fake.health = healthyJson({ entropy_health_detail: { probed_at_epoch: probed, age_s: 42, wrapper_state: "HEALTHY", fail_flags: [] } });
    const r = await get();
    assert.equal(r.status, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(hw(r.body).test_result, "passing");
    assert.equal(hw(r.body).time_stamp, new Date(probed * 1000).toISOString());
    for (const t of r.body.test_result) {
      assert.equal(typeof t.test_result, "string", "nenhum número inventado como resultado");
      assert.ok(!Number.isNaN(Date.parse(t.time_stamp)));
    }
  });

  test("observação vencida aparece como unavailable (stale_probe), nunca passing", async () => {
    fake.health = healthyJson({ entropy_health: "hw_health_unavailable",
      entropy_health_detail: { probed_at_epoch: Date.now() / 1000 - 900, age_s: 900, reason: "stale_probe" } });
    const r = await get();
    assert.equal(hw(r.body).test_result, "unavailable");
    const s = r.body.extensions.find((e) => e.name === "kuapoa.health_summary").data;
    assert.equal(s.continuous_tests.reason, "stale_probe");
    assert.equal(s.continuous_tests.observation_age_seconds, 900);
  });

  test("alarme é um resultado (200 + alarm), e estado desconhecido não vira passing", async () => {
    fake.health = healthyJson({ entropy_health: "hw_health_alarm",
      entropy_health_detail: { probed_at_epoch: Date.now() / 1000 - 5, age_s: 5, wrapper_state: "FAILED", fail_flags: ["apt_fail"], health_test_flags: ["apt_fail"] } });
    let r = await get();
    assert.equal(r.status, 200);
    assert.equal(hw(r.body).test_result, "alarm");
    fake.health = healthyJson({ entropy_health: "something_new" });
    r = await get();
    assert.equal(hw(r.body).test_result, "unknown");
  });

  test("sem sonda: not_assessed, e o carimbo é marcado como leitura de status", async () => {
    const h = healthyJson();
    delete h.entropy_health; delete h.entropy_health_detail;
    fake.health = h;
    const r = await get();
    assert.equal(hw(r.body).test_result, "not_assessed");
    const s = r.body.extensions.find((e) => e.name === "kuapoa.health_summary").data;
    assert.equal(s.continuous_tests.time_stamp_source, "status_read_no_observation");
    assert.equal(s.continuous_tests.observed_at, null);
  });

  test("histórico só como extensão marcada; some sem qualificação verificada", async () => {
    let r = await get();
    const h = r.body.extensions.find((e) => e.name === "kuapoa.historical_assessment");
    assert.equal(h.data.not_real_time_health, true);
    assert.equal(h.data.H_original_formal, 0.8725);
    assert.ok(!r.body.test_result.some((t) => /90b|historical|H_original/i.test(t.test_type)));
    fake.health = healthyJson({ qualification_status: "inactive_other_bitstream", qualification: null, conditioned: false });
    r = await get();
    assert.equal(r.body.extensions.find((e) => e.name === "kuapoa.historical_assessment"), undefined);
    const q = r.body.test_result.find((t) => t.test_type === "kuapoa_bitstream_qualification");
    assert.equal(q.test_result, "inactive_other_bitstream");
  });

  test("broker inacessível → 503 (contrato)", async () => {
    fake.healthStatus = 502;
    const r = await get();
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "HEALTH_TEST_SOURCE_UNAVAILABLE");
  });
});

// ── autenticação ─────────────────────────────────────────────────────────────
describe("autenticação (mesmo token das rotas atuais)", () => {
  test("sem token 401, token inválido 403, X-API-Key aceito, valores conflitantes 400", async () => {
    assert.equal((await agent.post("/v1/entropy").send({ block_size: 8 })).status, 401);
    assert.equal((await agent.get("/v1/capabilities")).status, 401);
    assert.equal((await agent.get("/v1/healthtest")).status, 401);
    assert.equal((await post({ block_size: 8 }, "dobslit_qrng_live_" + "0".repeat(40))).status, 403);
    const k = await agent.post("/v1/entropy").set("X-API-Key", tokenA).send({ block_size: 8 });
    assert.equal(k.status, 200);
    const same = await agent.post("/v1/entropy").set("X-API-Key", tokenA).set("Authorization", `Bearer ${tokenA}`).send({ block_size: 8 });
    assert.equal(same.status, 200);
    const diff = await agent.post("/v1/entropy").set("X-API-Key", "outro").set("Authorization", `Bearer ${tokenA}`).send({ block_size: 8 });
    assert.equal(diff.status, 400);
    assert.equal(diff.body.error, "AMBIGUOUS_CREDENTIALS");
  });

  test("rotas atuais inalteradas: X-API-Key não vale em /v1/random", async () => {
    const r = await agent.get("/v1/random?bytes=8").set("X-API-Key", tokenA);
    assert.equal(r.status, 401);
    assert.equal((await agent.get("/v1/random?bytes=8").set("Authorization", `Bearer ${tokenA}`)).status, 200);
  });

  test("CORS: preflight libera X-API-Key e POST", async () => {
    const r = await agent.options("/v1/entropy").set("Origin", "https://example.org")
      .set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "content-type,x-api-key");
    assert.equal(r.status, 200);
    assert.match(r.headers["access-control-allow-headers"], /X-API-Key/);
    assert.match(r.headers["access-control-allow-methods"], /POST/);
  });
});

// ── concorrência entre interfaces ────────────────────────────────────────────
describe("concorrência entre /v1/entropy e /v1/random", () => {
  test("nenhuma região do fluxo é entregue duas vezes; cada resposta é contínua e bate com uma retirada", async () => {
    const tokenB = await newToken("conc");
    const reqs = [];
    for (let i = 0; i < 30; i++) {
      if (i % 2 === 0) {
        const bs = 4 * (1 + (i % 7)), bc = 1 + (i % 5);
        reqs.push(post({ block_size: bs, block_count: bc }, i % 4 === 0 ? tokenA : tokenB)
          .then((r) => ({ status: r.status, buf: Buffer.concat(r.body.entropy.map((b) => Buffer.from(b, "base64"))) })));
      } else {
        const n = 4 * (2 + (i % 9));
        reqs.push(agent.get(`/v1/random?bytes=${n}&format=raw`).set("Authorization", `Bearer ${tokenB}`).buffer(true)
          .parse((res, cb) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); })
          .then((r) => ({ status: r.status, buf: r.body })));
      }
    }
    const before = fake.pops.length;
    const out = await Promise.all(reqs);
    const seen = new Set();
    let total = 0;
    for (const { status, buf } of out) {
      assert.equal(status, 200);
      const first = buf.readUInt32BE(0);
      for (let w = 0; w < buf.length / 4; w++) {
        const idx = buf.readUInt32BE(4 * w);
        assert.equal(idx, first + w, "resposta contínua");
        assert.ok(!seen.has(idx), `palavra ${idx} entregue duas vezes`);
        seen.add(idx);
      }
      total += buf.length;
    }
    const pops = fake.pops.slice(before);
    assert.equal(pops.length, 30, "uma retirada por requisição");
    assert.equal(pops.reduce((a, p) => a + p[1], 0), total, "nada retirado além do entregue");
  });
});

// ── logs ─────────────────────────────────────────────────────────────────────
describe("nenhum conteúdo de entropia em logs", () => {
  test("console e tabela de uso não contêm os blocos entregues", async () => {
    const captured = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const k of Object.keys(orig)) console[k] = (...a) => { captured.push(a.map(String).join(" ")); };
    let blocks;
    try {
      const r = await post({ block_size: 48, block_count: 3 });
      blocks = r.body.entropy;
      fake.mode = "timeout";
      await post({ block_size: 48 });
    } finally {
      Object.assign(console, orig);
    }
    const text = captured.join("\n");
    const rows = JSON.stringify(db.prepare("SELECT * FROM api_usage_logs").all());
    for (const b of blocks) {
      const hex = Buffer.from(b, "base64").toString("hex");
      for (const needle of [b, hex, b.slice(0, 16), hex.slice(0, 24)]) {
        assert.ok(!text.includes(needle), "bloco aparece no console");
        assert.ok(!rows.includes(needle), "bloco aparece em api_usage_logs");
      }
    }
  });
});

// ── especificação OpenAPI ────────────────────────────────────────────────────
describe("especificação OpenAPI pública", () => {
  test("documenta as três rotas, a autenticação por X-API-Key e os erros do contrato", async () => {
    const r = await agent.get("/v1/openapi.json");
    const p = r.body.paths;
    assert.ok(p["/capabilities"].get && p["/entropy"].post && p["/healthtest"].get);
    for (const code of ["422", "503"]) assert.ok(p["/entropy"].post.responses[code], `entropy ${code}`);
    assert.equal(r.body.components.securitySchemes.apiKeyHeader.name, "X-API-Key");
    assert.ok(r.body.components.schemas.QoaEntropyResponse);
  });
});
