#!/usr/bin/env node
"use strict";

/**
 * Regenera a cópia estática versionada da especificação OpenAPI a partir
 * do código real (server.js). Rodar sempre que rotas/schemas mudarem:
 *
 *   npm run openapi:generate
 *
 * O CI (ver .github/workflows/ci.yml) roda este script e falha se
 * openapi/qrng-public-v1.yaml divergir do que está commitado — isso é o
 * que impede a especificação de ficar desatualizada em relação ao código
 * (item 9.4 da auditoria: "controle de drift").
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { buildSpec } = require("./spec");

const spec = buildSpec();
const outPath = path.join(__dirname, "qrng-public-v1.yaml");

const header =
  "# GERADO AUTOMATICAMENTE por `npm run openapi:generate` a partir dos\n" +
  "# comentários @openapi em qrng-client-api/server.js. Não edite este\n" +
  "# arquivo manualmente -- edite os comentários JSDoc no código e rode\n" +
  "# o comando novamente. O CI falha se este arquivo divergir do gerado.\n";

fs.writeFileSync(outPath, header + yaml.dump(spec, { noRefs: true, lineWidth: 100 }));
console.log(`OpenAPI spec escrita em ${outPath}`);
console.log(`  paths: ${Object.keys(spec.paths || {}).length}`);
console.log(`  schemas: ${Object.keys((spec.components || {}).schemas || {}).length}`);
