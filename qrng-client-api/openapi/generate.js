#!/usr/bin/env node
"use strict";

/**
 * Regenera as cópias estáticas versionadas da especificação OpenAPI a
 * partir do código real (server.js). Rodar sempre que rotas/schemas
 * mudarem:
 *
 *   npm run openapi:generate
 *
 * O CI (ver .github/workflows/ci.yml) roda este script e falha se
 * openapi/qrng-public-v1.yaml ou openapi/qrng-internal-admin-v1.yaml
 * divergirem do que está commitado — isso é o que impede as
 * especificações de ficarem desatualizadas em relação ao código (item 9.4
 * da auditoria: "controle de drift").
 *
 * Item 7: duas specs, não uma -- ver openapi/spec.js. qrng-public-v1.yaml
 * nunca deve conter rotas /admin/*; qrng-internal-admin-v1.yaml documenta
 * só essas rotas e não é destinada a publicação num caminho anônimo.
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { buildPublicSpec, buildInternalAdminSpec } = require("./spec");

function writeSpec(spec, filename, warningLabel) {
  const outPath = path.join(__dirname, filename);
  const header =
    "# GERADO AUTOMATICAMENTE por `npm run openapi:generate` a partir dos\n" +
    "# comentários @openapi em qrng-client-api/server.js. Não edite este\n" +
    "# arquivo manualmente -- edite os comentários JSDoc no código e rode\n" +
    "# o comando novamente. O CI falha se este arquivo divergir do gerado.\n" +
    (warningLabel ? `# ${warningLabel}\n` : "");
  fs.writeFileSync(outPath, header + yaml.dump(spec, { noRefs: true, lineWidth: 100 }));
  console.log(`OpenAPI spec escrita em ${outPath}`);
  console.log(`  paths: ${Object.keys(spec.paths || {}).length}`);
  console.log(`  schemas: ${Object.keys((spec.components || {}).schemas || {}).length}`);
}

writeSpec(buildPublicSpec(), "qrng-public-v1.yaml");
writeSpec(
  buildInternalAdminSpec(),
  "qrng-internal-admin-v1.yaml",
  "ATENÇÃO: documenta rotas administrativas (role=admin). Não publique este arquivo num caminho anônimo."
);
