// E2E determinístico contra o serviço NIST de STAGING (fase item 5).
// /qrng/nist/  ->  nist-staging:18092 (versão controlada de nist_service.py,
// assessment FAKE determinístico, DB/data/upload isolados).
//
// Cobre ~18 cenários da política de upload + lifecycle de job:
//  abaixo/no/acima do limite, extensão inválida, conteúdo inválido, arquivo
//  vazio, falha do worker, fila, persistência, histórico, nomes iguais,
//  requisições concorrentes, captura live ausente, replay/histórico nunca
//  identificado como "live", request-id, atestação de proveniência.
// Limitações de infra (upload interrompido, timeout real, restart de processo)
// ficam marcadas test.fixme com justificativa.
import { test, expect } from "@playwright/test";
import crypto from "node:crypto";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
// nginx do staging espelha producao: /qrng/nist/ -> :18092/ . O frontend chama
// /qrng/nist/nist/<rota> (NIST_API + nistFetch("/nist/...")); /health fica na raiz.
const NP = "/qrng/nist/nist";        // status, jobs, upload
const NP_HEALTH = "/qrng/nist/health";

// arquivo .bin de N bytes determinístico
const binOf = (n, seed = 7) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 131 + seed) & 0xff;
  return b;
};
const txtInts = (n) =>
  Buffer.from(Array.from({ length: n }, (_, i) => (i * 2654435761) % 4294967295).join("\n") + "\n");

async function uploadFile(request, { name, mime, buffer, fields = {}, headers = {} }) {
  return request.post(`${NP}/upload`, {
    headers,
    multipart: {
      file: { name, mimeType: mime, buffer },
      test_type: "both",
      format: "auto",
      ...fields,
    },
  });
}

async function waitJob(request, jobId, { timeout = 30000 } = {}) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    const r = await request.get(`${NP}/jobs/${jobId}`);
    if (r.status() === 200) {
      last = await r.json();
      if (["completed", "failed"].includes(last.status)) return last;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return last;
}

test.describe.serial("NIST staging — identidade do serviço", () => {
  test("/health expõe version + commit + environment=staging (nunca 'production'/'live')", async ({ request }) => {
    const r = await request.get(`${NP_HEALTH}`);
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(b.service).toBe("qrng-nist-api");
    expect(b.version).toBeTruthy();
    expect(b).toHaveProperty("commit");
    expect(b.environment).toBe("staging");
    expect(b.environment).not.toBe("production");
    expect(b.upload_policy.full_file_in_memory).toBe(false);
    expect(b.upload_policy.streamed_to_temp_file).toBe(true);
    expect(b.upload_policy.allowed_extensions.sort()).toEqual([".bin", ".csv", ".txt"]);
    // header de versão em toda resposta
    expect(r.headers()["x-nist-service-version"]).toBe(b.version);
    expect(r.headers()["x-nist-service-env"]).toBe("staging");
  });

  test("/nist/status expõe service.version + environment e captura live ausente", async ({ request }) => {
    const r = await request.get(`${NP}/status`);
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(b.service.environment).toBe("staging");
    expect(b.enabled).toBe(true);
    // captura live NÃO configurada -> nada é "live"
    expect(b.live_capture_configured).toBe(false);
    expect(b.live_capture_status).toBe("not_configured");
  });
});

test.describe.serial("NIST staging — política de upload", () => {
  test("abaixo do limite: .bin aceito, resposta traz request_id, sha256, tamanhos, unidade", async ({ request }) => {
    const buf = binOf(4096);
    const r = await uploadFile(request, { name: "amostra.bin", mime: "application/octet-stream", buffer: buf });
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(b.status).toBe("queued");
    expect(b.job_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.request_id).toMatch(/^nist_/);
    expect(b.provenance).toBe("user_upload");
    expect(b.provenance).not.toBe("live");
    expect(b.sha256_original).toBe(sha256(buf));
    expect(b.size_original_bytes).toBe(4096);
    expect(b.size_normalized_bytes).toBe(4096); // .bin: passthrough
    expect(b.assessment_unit).toBe("byte");
    expect(b.assessment_symbol_width_bits).toBe(8);
    expect(b.normalization_method).toBe("raw-passthrough");
    expect(b.sample_endianness).toBe("unknown"); // sem atestação
  });

  test(".txt de inteiros aceito, normalização byte-decomposition", async ({ request }) => {
    const r = await uploadFile(request, { name: "vals.txt", mime: "text/plain", buffer: txtInts(400) });
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(b.normalization_method).toBe("byte-decomposition-le-uint32");
  });

  test(".csv aceito; size_normalized fica null até o job (não reprocessa no handler)", async ({ request }) => {
    const csv = Buffer.from("1,2,3,4\n5,6,7,8\n" + Array.from({ length: 300 }, (_, i) => i).join(",") + "\n");
    const r = await uploadFile(request, { name: "vals.csv", mime: "text/csv", buffer: csv });
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(b.normalization_method).toBe("byte-decomposition-le-uint32");
    expect(b.size_normalized_bytes).toBeNull();
  });

  test("no limite exato: aceito (limit bytes)", async ({ request }) => {
    const limit = (await (await request.get(`${NP_HEALTH}`)).json()).upload_policy.max_bytes;
    const r = await uploadFile(request, { name: "exato.bin", mime: "application/octet-stream", buffer: binOf(limit) });
    expect(r.status()).toBe(200);
  });

  test("acima do limite: 413 UPLOAD_TOO_LARGE estruturado com limit_bytes + request_id", async ({ request }) => {
    const limit = (await (await request.get(`${NP_HEALTH}`)).json()).upload_policy.max_bytes;
    const r = await uploadFile(request, {
      name: "grande.bin", mime: "application/octet-stream", buffer: binOf(limit + 65536),
    });
    expect(r.status()).toBe(413);
    const b = await r.json();
    expect(b.error).toBe("UPLOAD_TOO_LARGE");
    expect(b.limit_bytes).toBe(limit);
    expect(b.received_at_least_bytes).toBeGreaterThan(limit);
    expect(b.request_id).toMatch(/^nist_/);
  });

  test("um byte acima do limite: 413", async ({ request }) => {
    const limit = (await (await request.get(`${NP_HEALTH}`)).json()).upload_policy.max_bytes;
    const r = await uploadFile(request, { name: "p1.bin", mime: "application/octet-stream", buffer: binOf(limit + 1) });
    expect(r.status()).toBe(413);
  });

  test("extensão inválida: 400 UNSUPPORTED_EXTENSION com lista de permitidas", async ({ request }) => {
    const r = await uploadFile(request, { name: "doc.pdf", mime: "application/pdf", buffer: binOf(2048) });
    expect(r.status()).toBe(400);
    const b = await r.json();
    expect(b.error).toBe("UNSUPPORTED_EXTENSION");
    expect(b.allowed.sort()).toEqual([".bin", ".csv", ".txt"]);
    expect(b.request_id).toMatch(/^nist_/);
  });

  test("conteúdo inválido: .txt cheio de NUL -> 400 INVALID_CONTENT", async ({ request }) => {
    const bad = Buffer.alloc(2048, 0); // sem dígitos, com NUL
    const r = await uploadFile(request, { name: "lixo.txt", mime: "text/plain", buffer: bad });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe("INVALID_CONTENT");
  });

  test("arquivo vazio: 400 EMPTY_FILE", async ({ request }) => {
    const r = await uploadFile(request, { name: "vazio.bin", mime: "application/octet-stream", buffer: Buffer.alloc(0) });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe("EMPTY_FILE");
  });

  test("atestação uint32-le: sample_endianness=little, attested=true", async ({ request }) => {
    const r = await uploadFile(request, {
      name: "att.bin", mime: "application/octet-stream", buffer: binOf(4096),
      fields: { attested_transport_format: "uint32-le", attested_conditioned: "false" },
    });
    expect(r.status()).toBe(200);
    const b = await r.json();
    expect(b.attested).toBe(true);
    expect(b.sample_endianness).toBe("little");
  });

  test("atestação inválida: 400 INVALID_ATTESTED_TRANSPORT_FORMAT", async ({ request }) => {
    const r = await uploadFile(request, {
      name: "att2.bin", mime: "application/octet-stream", buffer: binOf(1024),
      fields: { attested_transport_format: "uint64-be" },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe("INVALID_ATTESTED_TRANSPORT_FORMAT");
  });

  test("X-Request-ID do cliente é ecoado na resposta e no header", async ({ request }) => {
    const rid = `nist_client_${crypto.randomBytes(4).toString("hex")}`;
    const r = await uploadFile(request, {
      name: "x.pdf", mime: "application/pdf", buffer: binOf(512), headers: { "X-Request-ID": rid },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).request_id).toBe(rid);
    expect(r.headers()["x-request-id"]).toBe(rid);
  });
});

test.describe.serial("NIST staging — lifecycle de job", () => {
  test("job normal completa via assessment fake (iid_passed, h_min presentes)", async ({ request }) => {
    const up = await uploadFile(request, { name: "ok.bin", mime: "application/octet-stream", buffer: binOf(8192) });
    const { job_id } = await up.json();
    const job = await waitJob(request, job_id);
    expect(job.status).toBe("completed");
    expect(job.iid_passed).toBe(true);
    expect(job.h_min_iid).toBeGreaterThan(0);
    expect(job.sample_origin).toBe("user_upload");
    expect(job.sample_origin).not.toBe("periodic_live");
  });

  test("falha do worker: marcador FORCE_NIST_FAKE_FAILURE -> job status=failed, não derruba o serviço", async ({ request }) => {
    const buf = Buffer.concat([Buffer.from("FORCE_NIST_FAKE_FAILURE"), binOf(4096)]);
    const up = await uploadFile(request, { name: "boom.bin", mime: "application/octet-stream", buffer: buf });
    const { job_id } = await up.json();
    const job = await waitJob(request, job_id);
    expect(job.status).toBe("failed");
    expect(job.error_message).toBeTruthy();
    // serviço continua de pé
    expect((await request.get(`${NP_HEALTH}`)).status()).toBe(200);
  });

  test("fila + concorrência: 4 uploads simultâneos -> 4 job_ids distintos, todos listados", async ({ request }) => {
    const ups = await Promise.all(
      [0, 1, 2, 3].map((k) =>
        uploadFile(request, { name: `c${k}.bin`, mime: "application/octet-stream", buffer: binOf(4096, k + 1) })
      )
    );
    const ids = await Promise.all(ups.map(async (u) => (await u.json()).job_id));
    expect(new Set(ids).size).toBe(4);
    const list = await (await request.get(`${NP}/jobs?limit=50`)).json();
    const listed = new Set(list.jobs.map((j) => j.id));
    for (const id of ids) expect(listed.has(id)).toBe(true);
  });

  test("nomes iguais: dois uploads 'sample.bin' -> job_ids distintos, ambos persistidos", async ({ request }) => {
    const a = await uploadFile(request, { name: "sample.bin", mime: "application/octet-stream", buffer: binOf(4096, 11) });
    const b = await uploadFile(request, { name: "sample.bin", mime: "application/octet-stream", buffer: binOf(4096, 12) });
    const ja = await a.json(), jb = await b.json();
    expect(ja.job_id).not.toBe(jb.job_id);
    expect((await request.get(`${NP}/jobs/${ja.job_id}`)).status()).toBe(200);
    expect((await request.get(`${NP}/jobs/${jb.job_id}`)).status()).toBe(200);
  });

  test("persistência + histórico: /nist/jobs lista com sample_origin; 404 para id desconhecido", async ({ request }) => {
    const list = await (await request.get(`${NP}/jobs?limit=50`)).json();
    expect(list.count).toBeGreaterThan(0);
    for (const j of list.jobs) {
      expect(["user_upload", "historical_assessment", "unknown"]).toContain(j.sample_origin);
      expect(j.sample_origin).not.toBe("live");
    }
    expect((await request.get(`${NP}/jobs/nao-existe-1234`)).status()).toBe(404);
  });

  test("replay/histórico nunca 'live': nenhum job é periodic_live e /status.last_job não alega amostra corrente", async ({ request }) => {
    const list = await (await request.get(`${NP}/jobs?limit=100`)).json();
    for (const j of list.jobs) {
      expect(j.sample_origin).not.toBe("periodic_live");
      expect(j.sample_file_is_stale === null || j.sample_file_is_stale === false).toBeTruthy();
    }
    const status = await (await request.get(`${NP}/status`)).json();
    if (status.last_job) expect(status.last_job.sample_origin).not.toBe("periodic_live");
  });
});

test.describe.serial("NIST staging — executor SINTÉTICO identificado (item 4)", () => {
  test("/health e /nist/status marcam engine=fake, synthetic_result=true, statistical_result_valid=false", async ({ request }) => {
    const h = await (await request.get(`${NP_HEALTH}`)).json();
    expect(h.assessment_engine).toBe("fake");
    expect(h.assessment_engine_version).toBeTruthy();
    expect(h.synthetic_result).toBe(true);
    expect(h.statistical_result_valid).toBe(false);
    const s = await (await request.get(`${NP}/status`)).json();
    expect(s.service.assessment_engine).toBe("fake");
    expect(s.service.synthetic_result).toBe(true);
    expect(s.service.statistical_result_valid).toBe(false);
  });

  test("job e histórico preservam a identificação synthetic", async ({ request }) => {
    const up = await uploadFile(request, { name: "syn.bin", mime: "application/octet-stream", buffer: binOf(8192) });
    const { job_id } = await up.json();
    const job = await waitJob(request, job_id);
    expect(job.status).toBe("completed");
    expect(job.assessment_engine).toBe("fake");
    expect(job.synthetic_result).toBe(true);
    expect(job.statistical_result_valid).toBe(false);
    const list = await (await request.get(`${NP}/jobs?limit=50`)).json();
    for (const j of list.jobs) expect(j.synthetic_result).toBe(true); // todos os jobs deste serviço
  });

  test("sem captura live: periodic_enabled=false e next_periodic=null (nenhuma execução agendada)", async ({ request }) => {
    const s = await (await request.get(`${NP}/status`)).json();
    expect(s.periodic_enabled).toBe(false);
    expect(s.next_periodic).toBeNull();
    expect(s.live_capture_configured).toBe(false);
    const h = await (await request.get(`${NP_HEALTH}`)).json();
    expect(h.periodic_enabled).toBe(false);
  });
});

test.describe.serial("NIST staging — endurecimento de upload (item 6)", () => {
  const bin = () => binOf(4096);

  for (const [nome, fname] of [
    ["path traversal posix", "../../etc/passwd.bin"],
    ["separadores windows", "..\\..\\windows\\system32\\evil.bin"],
    ["caminho absoluto", "/etc/shadow.bin"],
    ["unicode", "amostra-ção-éè.bin"],
    ["nome gigante", "x".repeat(400) + ".bin"],
  ]) {
    test(`filename malicioso aceito mas armazenado com nome do servidor: ${nome}`, async ({ request }) => {
      const r = await uploadFile(request, { name: fname, mime: "application/octet-stream", buffer: bin() });
      expect(r.status()).toBe(200);
      const b = await r.json();
      expect(b.server_generated_name).toBe(true);
      expect(b.stored_filename).toBe("sample.bin");             // nome do servidor, não o do usuário
      expect(b.stored_filename).not.toContain("/");
      expect(b.stored_filename).not.toContain("\\");
      expect(b.stored_filename).not.toContain("..");
      // o nome original vira metadado sanitizado
      expect(b.original_filename_sanitized).not.toContain("/");
      expect(b.original_filename_sanitized).not.toContain("\\");
    });
  }

  test("duas requisições concorrentes com o mesmo nome -> job_ids e diretórios distintos", async ({ request }) => {
    const [a, b] = await Promise.all([
      uploadFile(request, { name: "dup.bin", mime: "application/octet-stream", buffer: binOf(4096, 1) }),
      uploadFile(request, { name: "dup.bin", mime: "application/octet-stream", buffer: binOf(4096, 2) }),
    ]);
    const ja = await a.json(), jb = await b.json();
    expect(ja.job_id).not.toBe(jb.job_id);
    expect(ja.stored_filename).toBe("sample.bin");
    expect(jb.stored_filename).toBe("sample.bin");
  });

  test(".txt de inteiros: normalização registrada APÓS o worker (não pela extensão)", async ({ request }) => {
    const txt = Buffer.from(Array.from({ length: 500 }, (_, i) => i).join("\n") + "\n");
    const up = await uploadFile(request, { name: "ints.txt", mime: "text/plain", buffer: txt });
    const b = await up.json();
    expect(b.normalized_pending).toBe(true);        // .txt não é declarado normalizado no handler
    expect(b.size_normalized_bytes).toBeNull();
    const job = await waitJob(request, b.job_id);
    expect(job.status).toBe("completed");
    expect(job.sha256_normalized).toMatch(/^[0-9a-f]{64}$/);
    expect(job.normalized_symbol_count).toBeGreaterThan(0);
    expect(job.endianness_rule).toContain("little-endian");
    expect(job.first_parse_error).toBeFalsy();
  });

  test(".csv com inteiro negativo: job registra first_parse_error", async ({ request }) => {
    const csv = Buffer.from("1,2,3\n4,-5,6\n" + Array.from({ length: 400 }, (_, i) => i).join(",") + "\n");
    const up = await uploadFile(request, { name: "neg.csv", mime: "text/csv", buffer: csv });
    const job = await waitJob(request, (await up.json()).job_id);
    expect(["completed", "failed"]).toContain(job.status);
    expect(job.first_parse_error || "").toMatch(/negativo/i);
  });

  test(".csv com inteiro acima de uint32: first_parse_error", async ({ request }) => {
    const csv = Buffer.from(`1\n2\n${2 ** 32}\n` + Array.from({ length: 400 }, (_, i) => i).join("\n") + "\n");
    const job = await waitJob(request, (await (await uploadFile(request, { name: "ovf.csv", mime: "text/csv", buffer: csv })).json()).job_id);
    expect(job.first_parse_error || "").toMatch(/uint32/i);
  });

  test(".txt sem nenhum inteiro válido (texto com dígitos): job falha com erro explícito", async ({ request }) => {
    // 300+ linhas de texto não-inteiro para passar do NIST_MIN_BYTES
    const txt = Buffer.from(Array.from({ length: 400 }, () => "versao 1.2.3 build abc").join("\n") + "\n");
    const job = await waitJob(request, (await (await uploadFile(request, { name: "bad.txt", mime: "text/plain", buffer: txt })).json()).job_id);
    expect(job.status).toBe("failed");
    expect(job.error_message || "").toMatch(/inteiro|parse|válido/i);
  });

  test(".csv com nº de colunas inconsistente: first_parse_error menciona colunas", async ({ request }) => {
    const csv = Buffer.from("1,2,3\n4,5\n" + Array.from({ length: 400 }, (_, i) => `${i},${i + 1},${i + 2}`).join("\n") + "\n");
    const job = await waitJob(request, (await (await uploadFile(request, { name: "cols.csv", mime: "text/csv", buffer: csv })).json()).job_id);
    expect(job.first_parse_error || "").toMatch(/colunas/i);
  });
});

// ── Limitações de infraestrutura (não simular como aprovado) ──────────────────
test.describe("NIST staging — cenários bloqueados por infraestrutura", () => {
  test.fixme(true, "upload interrompido no meio: exige cortar a conexão TCP no cliente HTTP — APIRequestContext não expõe isso. Verificado indiretamente: _stream_upload_to_file faz cleanup do .part em qualquer exceção (teste unitário test_safe_unlink / try/except no handler).");
  test.fixme(true, "timeout real do assessment: exige um job que exceda NIST_TEST_TIMEOUT_SECONDS. O fake é instantâneo; forçar sleep>120s tornaria o CI lento. subprocess.run(timeout=) já é exercido pelo código de produção.");
  test.fixme(true, "restart do processo no meio da fila: exige matar/reiniciar o container nist-staging durante um job. A fila é in-memory (queue.Queue) — jobs 'queued' não sobrevivem a restart; jobs no DB permanecem com o último status. Documentado em NIST_STAGING.md.");
});
