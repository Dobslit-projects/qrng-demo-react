// Verifica que `eslint` REALMENTE reprova (exit != 0) quando um erro de lint
// real e introduzido -- e passa (exit 0) num arquivo limpo. Prova que o lint
// e um gate efetivo, nao decorativo.
//
// Uso:  node scripts/lint-gate.mjs <dir-lintado>
//   <dir-lintado> = diretorio DENTRO do escopo de um eslint.config.js
//                   (ex.: "src" para o frontend; "." rodando de qrng-client-api).
//
// CI: um passo em cada job que roda lint (frontend e qrng-client-api).

import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const dir = process.argv[2];
if (!dir) {
  console.error("uso: node scripts/lint-gate.mjs <dir-lintado>");
  process.exit(2);
}

const BAD = join(dir, "__lint_gate_bad__.js");
const GOOD = join(dir, "__lint_gate_good__.js");

// Erro de lint inequivocamente real: variavel redeclarada + nao usada +
// referencia a identificador nao definido. Nao depende de nenhuma regra
// "opinativa" -- `no-redeclare`, `no-unused-vars` e `no-undef` estao em
// js.configs.recommended, usado por todos os configs do repo.
const badSource = [
  "const gateDupe = 1;",
  "const gateDupe = 2;",
  "thisIdentifierIsNotDefinedAnywhere();",
  "",
].join("\n");

// Valido tanto em sourceType "module" (frontend) quanto "commonjs" (API):
// sem import/export, sem bloco vazio, e `gateOk` e efetivamente usado.
const goodSource = [
  "const gateOk = 42;",
  "globalThis.__lintGateOk = gateOk;",
  "",
].join("\n");

function runEslint(file) {
  // `npx --no-install eslint`: usa o eslint ja instalado no projeto (o mesmo
  // que `npm run lint`), nunca baixa outra versao.
  return spawnSync("npx", ["--no-install", "eslint", file], {
    encoding: "utf8",
    shell: true,
  });
}

let failures = 0;

try {
  writeFileSync(BAD, badSource);
  const bad = runEslint(BAD);
  if (bad.status === 0) {
    console.error(`FAIL: eslint saiu 0 num arquivo com erro real (${BAD})`);
    console.error(bad.stdout || bad.stderr);
    failures++;
  } else {
    const out = (bad.stdout || "") + (bad.stderr || "");
    const hasRule = /no-redeclare|no-undef|no-unused-vars/.test(out);
    console.log(`ok: eslint reprovou o arquivo ruim (exit ${bad.status})` +
      (hasRule ? " citando as regras esperadas" : " (output nao capturado, mas o exit != 0 e o gate)"));
  }
} finally {
  rmSync(BAD, { force: true });
}

try {
  writeFileSync(GOOD, goodSource);
  const good = runEslint(GOOD);
  if (good.status !== 0) {
    console.error(`FAIL: eslint reprovou um arquivo limpo (${GOOD}), exit ${good.status}`);
    console.error(good.stdout || good.stderr);
    failures++;
  } else {
    console.log("ok: eslint aprovou o arquivo limpo (exit 0)");
  }
} finally {
  rmSync(GOOD, { force: true });
}

process.exit(failures === 0 ? 0 : 1);
