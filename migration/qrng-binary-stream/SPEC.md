# QRNG Binary Stream Specification
**Version:** 1.0  
**Date:** 2026-08-15  
**Status:** Migration target (replaces ASCII decimal format)

---

## 1. Physical source (Layer A — unchanged)

AXI FIFO interface to FPGA laser/APD/ADC pipeline.  
Register offset `0x43C00000 + 0x11000`. One 32-bit read per sample.  
**Nothing in this specification alters the hardware or its firmware.**

---

## 2. FPGA serialization (Layer B — this migration)

### Before (ASCII)
```c
fprintf(store, "%u", num);  // variable-width decimal, no delimiter
```
- Stream: bytes 0x30–0x39 ('0'–'9') only
- Width per sample: 1–10 bytes (mean ≈ 9.4 bytes for uniform uint32)
- Framing: none — no delimiters, no fixed width
- H_min(B): 3.078 bits/byte (ASCII digit layer)

### After (binary LE — this spec)
```c
uint32_t le = htole32(num);
write_all(STDOUT_FILENO, &le, sizeof(le));  // 4 bytes, fixed width, no encoding
```
- Stream: bytes 0x00–0xFF (full range)
- Width per sample: **4 bytes exactly, always**
- Framing: fixed-width — byte N belongs to sample ⌊N/4⌋
- Byte order: little-endian (LSB first)
- H_min(B): 6.988 ± 0.025 bits/byte (NIST ea_non_iid, Auditoria 5.2/6, valid)
- Throughput: same number of samples at ~2.35× fewer bytes (9.4 → 4 bytes/sample)

---

## 3. Framing invariant

```
For any byte position N in the stream: sample_index = N ÷ 4  (integer division)
```

- The stream is a flat sequence of 4-byte little-endian uint32 values.
- No sync bytes, no headers, no length prefixes, no delimiters.
- Consumers MUST read in multiples of 4 bytes to preserve alignment.
- A dropped or inserted byte corrupts alignment permanently for that TCP session.
  Recovery requires reconnecting (qrng-connector.py reconnects on socket close).

---

## 4. TCP transport (unchanged)

`nc -k -l 0.0.0.0 12345` — single-producer, single-consumer TCP stream.  
The connector (`qrng-connector.py`) reads in 64 KB chunks and passes bytes verbatim.  
No framing is added at the TCP layer.

---

## 5. RingBuffer (unchanged)

`RingBuffer(256 MB)` in `server_api.py` stores raw bytes verbatim.  
No parsing, no encoding, no framing. Byte-for-byte pass-through from TCP.

---

## 6. API surface

### Existing endpoints (preserved, backward-compatible)

| Endpoint | Content-Type | Description |
|---|---|---|
| `GET /health` | application/json | Buffer stats + source status |
| `GET /random?bytes=N` | application/octet-stream (default) | N raw bytes from buffer |
| `GET /random?bytes=N&format=hex` | application/json | N bytes as hex string |
| `GET /random_hex?bytes=N` | application/json | N bytes as hex string |
| `GET /stream` | application/octet-stream | Infinite streaming |

After migration, the content of these bytes is binary uint32 LE (instead of ASCII digits).  
The API contracts themselves are unchanged.

### New endpoints (added in this migration)

| Endpoint | Content-Type | Description |
|---|---|---|
| `GET /v1/raw?bytes=N` | application/octet-stream | N bytes (must be multiple of 4) |
| `GET /v1/uint32?count=N` | application/json | count uint32 values as JSON array |

**`/v1/raw`:**
- `bytes` must be a multiple of 4; if not, rounded down to nearest multiple of 4.
- Response is raw bytes, no encoding. Content-Type: `application/octet-stream`.
- If buffer has insufficient data: HTTP 503 JSON `{"error": "QRNG_UNAVAILABLE"}`.
- Header `X-QRNG-Format: uint32-le` and `X-QRNG-Sample-Width: 4` always present.
- Header `X-QRNG-Conditioned: false` — source is unconditioned.
- `N` max: 50 MB.

**`/v1/uint32`:**
- Reads `count × 4` bytes from buffer.
- Parses as `count` little-endian uint32 values.
- Returns JSON: `{"count": N, "values": [v0, v1, ...], "source": "fpga"}`.
- `count` max: 131072 (= 512 KB / 4).

---

## 7. Health endpoint additions

```json
{
  "stream_format":      "uint32-le",
  "sample_width_bytes": 4,
  "conditioned":        false
}
```

These fields are additive to the existing health response. Existing fields unchanged.

---

## 8. Conditioning (Phase 19)

**No conditioning is implemented in this migration.**

The source is characterized as non-IID with H_min = 6.988 ± 0.025 bits/byte.  
Proper conditioning would require:
- An approved construction (e.g., Hash_df or HMAC_DRBG from NIST SP 800-90A)
- Entropy budget: H_extracted ≤ H_min × input_bytes = 6.988 × input_bytes / 8 bits
- Input block size ≥ 2/H_min = 2/6.988 ≈ 0.286 bytes → effectively any block size works
- Separate endpoint (e.g., `/v1/conditioned`) — never silently replaces `/v1/raw`

This is deferred. `/v1/raw` explicitly documents `conditioned=false`.

---

## 9. No-PRNG rule (absolute)

When the buffer is empty, all endpoints return HTTP 503.  
**No pseudo-random fallback exists or will be added.**  
The source indisponibility is observable via `/health` → `source_status`.

---

## 10. API versioning

`/v1/raw` and `/v1/uint32` are new routes, not replacements.  
Existing routes (`/random`, `/random_hex`, `/stream`) preserved.  
Semantic change: bytes served by existing routes are now binary (not ASCII digits).  
Clients that used ASCII-specific parsing (e.g., rejection sampling on digit streams)  
should be updated. The `qrng-client-api/server.js` `parseUpstreamRandom` function  
is updated in this migration to remove the now-dead ASCII branch.

---

## 11. Rollback

See `snapshots/pre-binary-migration-2026-08-14/MANIFEST.md` for full rollback instructions.  
Production tag: `qrng-pre-binary-migration-2026-08-14`  
Pre-migration SHA-256 of fifo.c: `8a338ad7534b8474f54392b01f0099f3a08993c4833e549fb3f748e364ef2367`

---

## 12. Statistical reference (unchanged)

| Metric | Value | Layer | Source |
|---|---|---|---|
| H_min(B) | 6.988 ± 0.025 bits/byte | Binary LE uint32 | NIST ea_non_iid, Audit 5.2/6 |
| Classification | non-IID | B | Compression Test |
| H_iid(C) | 3.078 bits/digit | ASCII (pre-migration) | NIST ea_iid, Audit 5 |
| SHA-256 proof | `968b9465...` | B | bin=txt→bin, Audit 6 |

Layer B (binary uint32 LE) is the correct representation for entropy measurement.  
H_min(B) = 6.988 bits/byte is valid and requires no recalculation after this migration.
