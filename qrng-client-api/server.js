const express = require("express");
const rateLimit = require("express-rate-limit");
const fetch = require("node-fetch");

const app = express();

const PORT = process.env.PORT || 3010;
const QRNG_UPSTREAM = process.env.QRNG_UPSTREAM || "http://127.0.0.1:18001";
const API_TOKEN = process.env.QRNG_CLIENT_TOKEN || "troque-este-token";

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

function requireToken(req, res, next) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "missing_token",
      message: "Use Authorization: Bearer <token>",
    });
  }

  const token = auth.replace("Bearer ", "").trim();

  if (token !== API_TOKEN) {
    return res.status(403).json({
      error: "invalid_token",
      message: "Invalid API token",
    });
  }

  next();
}

function parseUpstreamRandom(buffer, requestedBytes) {
  const text = buffer.toString("utf8").trim();

  // Caso 1: backend retorna JSON
  try {
    const json = JSON.parse(text);

    if (Array.isArray(json.bytes)) {
      return Buffer.from(json.bytes.slice(0, requestedBytes));
    }

    if (typeof json.hex === "string") {
      return Buffer.from(json.hex, "hex").slice(0, requestedBytes);
    }

    if (typeof json.random === "string") {
      return Buffer.from(json.random, "hex").slice(0, requestedBytes);
    }
  } catch (_) {
    // Não era JSON, segue abaixo.
  }

  // Caso 2: backend retorna números em texto: "123\n44\n255\n"
  // Só interpreta como texto se o conteúdo tiver apenas dígitos, espaços, vírgulas ou quebras de linha.
// Caso 2: backend retorna números em texto separados por espaço, vírgula ou quebra de linha.
// Exemplo: "123\n44\n255\n" ou "123,44,255".
//
// Importante: se vier uma sequência contínua tipo "456371580315...",
// isso NÃO deve ser tratado como lista decimal. Nesse caso, usamos como bytes brutos.
if (/^[0-9,\s]+$/.test(text) && /[\s,]/.test(text) && text.length > 0) {
  const values = text
    .split(/[\s,]+/)
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    .slice(0, requestedBytes);

  if (values.length > 0) {
    return Buffer.from(values);
  }
}

  // Caso 3: backend retorna bytes brutos/binários.
  return buffer.slice(0, requestedBytes);
}

app.get("/v1/health", requireToken, async (req, res) => {
  try {
    const r = await fetch(`${QRNG_UPSTREAM}/health`);
    const data = await r.json();

    res.json({
      status: "ok",
      api: "dobslit-qrng-client-api",
      source: "ufpe-fpga",
      upstream: data,
    });
  } catch (err) {
    res.status(503).json({
      status: "error",
      message: "QRNG upstream unavailable",
    });
  }
});

app.get("/v1/random", requireToken, async (req, res) => {
  const bytes = Math.min(parseInt(req.query.bytes || "32", 10), 4096);
  const format = req.query.format || "hex";

  if (bytes < 1) {
    return res.status(400).json({
      error: "invalid_bytes",
      message: "bytes must be >= 1",
    });
  }

  try {
    // Pedimos um pouco mais para manter compatibilidade caso o backend antigo
    // retorne números em texto. Se vier binário, usamos só os primeiros N bytes.
    const upstreamBytes = Math.min(bytes * 5, 50 * 1024 * 1024);
    const r = await fetch(`${QRNG_UPSTREAM}/random?bytes=${upstreamBytes}`);

    if (!r.ok) {
      return res.status(502).json({
        error: "upstream_error",
        status: r.status,
      });
    }

    const upstreamBuffer = await r.buffer();
    const buffer = parseUpstreamRandom(upstreamBuffer, bytes);

    if (buffer.length < bytes) {
      return res.status(503).json({
        error: "insufficient_entropy",
        message: "Not enough QRNG bytes available",
        available: buffer.length,
        requested: bytes,
      });
    }

    let random;

    if (format === "hex") {
      random = buffer.toString("hex");
    } else if (format === "base64") {
      random = buffer.toString("base64");
    } else if (format === "uint8") {
      random = Array.from(buffer);
    } else {
      return res.status(400).json({
        error: "invalid_format",
        message: "Use format=hex, base64 or uint8",
      });
    }

    res.json({
      source: "dobslit-qrng-ufpe-fpga",
      bytes,
      format,
      random,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      error: "qrng_unavailable",
      message: "Could not fetch QRNG data",
      detail: err.message,
    });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`QRNG client API listening on http://127.0.0.1:${PORT}`);
});
