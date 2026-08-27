# Section 1 — post-deploy evidence (Kapuã QRNG)

Collected **2026-08-27** against the **running production** `qrng-client-api` on the Bongo VM
(`2.24.117.58`), image `qrng-demo-react-qrng-api` (`sha256:10087183b583`) built 2026-08-26
00:44:01 UTC, container up since 2026-08-26 00:46:06 UTC, single `node server.js` process
(not clustered). HTTP probes from the VM loopback to `http://127.0.0.1:3010`; the
`X-Forwarded-For` test was run from an external host through `https://bongo.dobslit.com`.
Raw run log: `SECTION1_POSTDEPLOY_EVIDENCE.run.json`.

## Deploy identity

| Fact | Value |
|---|---|
| `main` / `origin/main` | `f058f22` (the report's HEAD) — **confirmed** |
| Merge into main | fast-forward, already done by the prior session (`reflog`: `merge stabilize/qrng-pipeline-20260826: Fast-forward`) |
| Running image | `sha256:10087183b583…`, built 2026-08-26 00:44:01 UTC |
| Container (re)created | 2026-08-26 00:46:06 UTC |
| `trust proxy` in running code | `app.set("trust proxy", "loopback")` present at `server.js:29` (verified inside the container) |
| DB | `/data/qrng-tokens.db` (mounted volume — persists across rebuilds) |

## Checklist

| # | Check | Result | Evidence |
|---|---|---|---|
| a | HEAD = `f058f22` | ✅ | `git rev-parse` on VM = `f058f224177a…` |
| b | Commits incorporated | ✅ | `d255cc6` trust-proxy/crypto-disable/rebrand · `10c694f` claims · `2f381b1` cleanup · `f058f22` docs (report §16) |
| c | Health | ✅ | `/v1/health/self` → `{"status":"ok"}`; `/v1/health` (token) → 200, upstream: `source_status:"online"`, `buffer_bytes_available:268435456/268435456`, `stream_format:"uint32-le"`, `sample_width_bytes:4`, `conditioned:false`, `total_pushed:9638315600` |
| d | Hex | ✅ | `bytes`=1/32/1000/100000 → 1/32/1000/100000 bytes decoded, exact |
| e | Base64 | ✅ | same 4 sizes, exact after b64decode |
| f | uint8 | ✅ | same 4 sizes, JSON array length exact, all values ∈ [0,255] |
| g | "Raw" | ⚠️ **drift** | `/v1/random` with no `format` returns `application/json` (`random` hex string), **not** `application/octet-stream` as OpenAPI claims. Frontend "Raw" decodes hex client-side. → fix in item 12/13. |
| h | N requested → N delivered | ✅ | 12/12 exact across hex·base64·uint8 × {1, 32, 1000, 100000} |
| i | Monte Carlo, no value ≥ 1 (U = uint32_LE / 2³²) | ✅ | 100 000 samples: `U_mean`=0.497302, `U_max`=0.99998881 (`1−U_max`=1.12e-5), **`count_U_ge_1` = 0**. block SHA-256 `7a4e916a…b282068`. (mean again slightly < 0.5 — consistent with the report's documented small negative bias; smaller sample here.) |
| j | Fallback | ⏳ deferred | `/v1/public/random` has **no** fallback by design (502/503 on upstream failure). Frontend fallback (`qrngFallbackData.js`) → browser E2E, item 10. |
| k | Swagger | ✅ | `/v1/docs/` → HTTP 200 `text/html` 3120 B |
| l | ReDoc | ✅ | `/v1/redoc` → HTTP 200 `text/html` (loads redoc bundle from CDN — external dep) |
| m | OpenAPI | ✅ | `/v1/openapi.json` → HTTP 200, valid OpenAPI 3.0.3, `info` "Kapuã QRNG — API Pública" v1.0.0, 21069 B |
| n | Two-client quotas | ✅ | token A driven to its 60 req/min limit → 429; **token B returns 200 in the same window**; `/v1/me/usage` shows A `requests_today:60`, B `requests_today:1` — separate buckets |
| o | Forge `X-Forwarded-For` | ✅ | 12 requests through nginx each with a distinct spoofed `X-Forwarded-For` (`203.0.113.1…12`) drew down **one shared** `RateLimit-Remaining` counter (19→8) instead of getting a fresh 20 each — the limiter keys on the real client IP, not the header. Burst of 30 with rotating spoof → 429s appear. |
| p | 429 response | ✅ | per-token: first 429 at request #47 in-window, body `RATE_LIMIT_EXCEEDED` "Limite de 60 req/min por token atingido", `Retry-After: 30`. per-IP public: 429 in burst. Also 413 (`bytes`=65537), 422 (`bytes`=-4). |
| q | Rollback prepared | ✅ | see below |

### Observation (not a failure)
`express-rate-limit` uses a **fixed 60 s window**; long test runs (fresh TLS per curl) crossed
window boundaries, so `RateLimit-Remaining` resets and 429→200 recovery were seen mid-burst.
Enforcement is correct; the window is just short relative to a slow serial test. A distributed
store would also make the public limit exact under future multi-instance deploys — noted for
item 12/roadmap, not a Section 1 blocker.

## Rollback

- **Code:** `git -C /root/projects/qrng-demo-react checkout 5c6d07a` (commit immediately before
  `d255cc6`; = `fix(deploy): copy openapi/ into the qrng-client-api image`), then
  `docker compose -f docker-compose.yml up -d --build`.
- **Image (fast path):** the previous `qrng-demo-react-qrng-api:latest` was overwritten by the
  2026-08-26 00:44 build — no retained same-repo tag. Last-resort image on the box:
  `qrng-qrng-api:latest` `edb66c11b0dc` (2026-08-12, older compose project). Prefer the
  rebuild-from-`5c6d07a` path.
- **nginx:** unchanged by this deploy — no rollback needed.
- **DB:** `/data/qrng-tokens.db` schema unchanged between `5c6d07a` and `f058f22` — no migration to reverse.

## Cleanup done
Two throwaway accounts (`qa-sec1-…@qa.invalid`, user ids 2 & 3, token ids 1 & 2) and their
usage rows were hard-deleted from `/data/qrng-tokens.db` after the run — `users_left: 0`,
`tokens_left: 0`. User id 1 (real) untouched.
