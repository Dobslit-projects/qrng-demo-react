// Stubs do ambiente de teste do gate (sem dependências, Node 20).
//
//   :3001   SPA do QRNG          (prod: qrng-web-1 em 127.0.0.1:3001)
//   :18002  serviço NIST         (prod: 127.0.0.1:18002) — /health, /nist/status, POST /nist/{upload,run}
//   :8081   front do portal      (prod: bongosite-front em 127.0.0.1:8081) — /, /cards, ...
//   :8099   demais apps do host  (dobflight :5000, qml :8100, faro :8090)
//
// Cada resposta traz um marcador (`stub`) para o run-matrix saber QUEM
// respondeu (o upstream de verdade, ou uma página/JSON gerada pelo nginx).
// Nenhum cabeçalho ou corpo recebido é registrado em log.
import http from "node:http";

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function drain(req, cb) {
  let n = 0;
  req.on("data", (c) => { n += c.length; });
  req.on("end", () => cb(n));
}

const html = (marker, path) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${marker}</title></head>` +
  `<body data-stub="${marker}"><p>${marker} ${path.replace(/[<>&"]/g, "")}</p></body></html>`;

const servers = {
  3001: (req, res) => send(res, 200, "text/html; charset=utf-8", html("qrng-spa-stub", req.url)),
  8081: (req, res) => send(res, 200, "text/html; charset=utf-8", html("bongo-front-stub", req.url)),
  8099: (req, res) => send(res, 200, "text/plain; charset=utf-8", `misc-app-stub ${req.url}\n`),
  18002: (req, res) => {
    const url = new URL(req.url, "http://stub");
    const json = (status, obj) => send(res, status, "application/json", JSON.stringify({ stub: "nist-stub", ...obj }));
    if (req.method === "GET" && url.pathname === "/health") return json(200, { status: "ok", environment: "authgate" });
    if (req.method === "GET" && url.pathname === "/nist/status") return json(200, { busy: false });
    if (req.method === "POST" && (url.pathname === "/nist/run" || url.pathname === "/nist/upload")) {
      return drain(req, (n) => json(200, { accepted: true, received_bytes: n, job_id: "stub-job" }));
    }
    return json(404, { error: "NOT_FOUND" });
  },
};

for (const [port, handler] of Object.entries(servers)) {
  http.createServer(handler).listen(Number(port), "0.0.0.0", () => console.log(`[stubs] :${port} pronto`));
}
