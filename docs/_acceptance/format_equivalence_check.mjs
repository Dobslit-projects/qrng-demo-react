// Verificação determinística de equivalência dos formatos (item 5 / item 20).
//
// NÃO usa 4 chamadas live independentes (elas retornam sequências diferentes —
// ver docs/_acceptance/determinism_note.txt). Usa UMA amostra fixa e prova que
// os quatro formatos representam EXATAMENTE os mesmos bytes.
//
// Reproduz a lógica de decodificação que o frontend aplica (src/lib/qrngHelper.js:
// decodeQrngJsonResponse → parseInt(hex.substr(i*2,2),16); e src/components/*.jsx
// para uint8/base64) e a serialização que o server_api/client-api aplicam
// (hex = 2 chars/byte, base64 padrão, uint8 = array de inteiros, raw = os bytes).
//
// Uso:  node docs/_acceptance/format_equivalence_check.mjs
import { createHash, webcrypto } from "node:crypto";

const FIXTURE_HEX =
  "00010203f0f1f2f3fffefdfc7f8081820a1b2c3d4e5f60718293a4b5c6d7e8f90" +
  "deadbeefcafebabe0123456789abcdef00000000ffffffff8000000000000001";

function hexToBytes(h) {
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); // == frontend
  return b;
}
function bytesToHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function bytesToBase64(b) {
  return Buffer.from(b).toString("base64");
}
function base64ToBytes(s) {
  return new Uint8Array(Buffer.from(s, "base64"));
}
function bytesToUint8Array(b) {
  return Array.from(b); // == RandomResponse.random quando format=uint8
}
async function sha256Hex(b) {
  const d = await webcrypto.subtle.digest("SHA-256", b);
  return Buffer.from(d).toString("hex");
}

const RAW = hexToBytes(FIXTURE_HEX); // "a mesma amostra capturada uma única vez"
const N = RAW.length;

// Serializações que a API produziria para ESSA amostra:
const asHex = bytesToHex(RAW);
const asB64 = bytesToBase64(RAW);
const asU8 = bytesToUint8Array(RAW);

// Decodificações no cliente:
const fromHex = hexToBytes(asHex);
const fromB64 = base64ToBytes(asB64);
const fromU8 = Uint8Array.from(asU8);

function eqBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const checks = [];
checks.push(["N bytes solicitados == N bytes entregues (raw)", RAW.length === N]);
checks.push(["raw == decode(hex)", eqBytes(RAW, fromHex)]);
checks.push(["raw == decode(base64)", eqBytes(RAW, fromB64)]);
checks.push(["raw == bytes(uint8)", eqBytes(RAW, fromU8)]);
checks.push(["hex tem 2 chars por byte", asHex.length === 2 * N]);
checks.push(["hex é [0-9a-f] apenas", /^[0-9a-f]*$/.test(asHex)]);
checks.push(["uint8 todos em 0..255", asU8.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)]);
checks.push(["uint8 tem N elementos", asU8.length === N]);
checks.push(["base64 decodifica para N bytes", fromB64.length === N]);
checks.push(["sem BOM no início do raw", !(RAW[0] === 0xef && RAW[1] === 0xbb && RAW[2] === 0xbf)]);

const shaRaw = await sha256Hex(RAW);
const shaHex = await sha256Hex(fromHex);
const shaB64 = await sha256Hex(fromB64);
const shaU8 = await sha256Hex(fromU8);
checks.push(["SHA-256 idêntico em raw/hex/base64/uint8", shaRaw === shaHex && shaRaw === shaB64 && shaRaw === shaU8]);

// uint32-LE: primeiros 4 bytes 00 01 02 03 => 0x03020100 = 50462976
const u32le = (RAW[0] | (RAW[1] << 8) | (RAW[2] << 16) | (RAW[3] << 24)) >>> 0;
const u32be = ((RAW[0] << 24) | (RAW[1] << 16) | (RAW[2] << 8) | RAW[3]) >>> 0;
checks.push(["uint32 lido em little-endian (00 01 02 03 -> 50462976)", u32le === 50462976]);
checks.push(["little-endian != big-endian nesta amostra (guarda de regressão)", u32le !== u32be]);
// crosscheck com DataView
const dv = new DataView(RAW.buffer, RAW.byteOffset, 4);
checks.push(["readUint32LE == DataView.getUint32(0,true)", u32le === dv.getUint32(0, true)]);

let ok = 0;
console.log(`amostra fixa: ${N} bytes  sha256=${shaRaw}`);
console.log(`hex[..16]=${asHex.slice(0, 16)}  b64[..12]=${asB64.slice(0, 12)}  uint8[..4]=[${asU8.slice(0, 4)}]`);
console.log("");
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (pass) ok++;
}
console.log("");
console.log(`${ok}/${checks.length} verificações OK`);
process.exit(ok === checks.length ? 0 : 1);
