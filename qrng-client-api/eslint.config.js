// ESLint (flat config) para a API de produção qrng-client-api.
//
// Pacote Node/Express separado (CommonJS: require / module.exports). Este
// config analisa o CÓDIGO ATIVO da API -- server.js, o gerador/spec do
// OpenAPI e a suíte de testes -- com globais de Node. Rodar: `npm run lint`
// (ou `npx eslint .`). O job "qrng-client-api" do CI executa este lint como
// passo bloqueante.
//
// O eslint.config.js da raiz IGNORA qrng-client-api/** de propósito -- o
// frontend (browser/React) e a API (Node) têm ambientes e regras distintos;
// cada um roda o seu próprio lint. Não é "ignorar silenciosamente": a API é
// efetivamente lintada, por este arquivo, no seu próprio job de CI.

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/**", "coverage/**"] },

  {
    files: ["**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Igual à convenção do frontend: nomes começando com _ ou MAIÚSCULA
      // podem ficar sem uso (ex.: parâmetros de posição, constantes).
      "no-unused-vars": ["error", {
        varsIgnorePattern: "^[A-Z_]",
        argsIgnorePattern: "^_",
        caughtErrors: "none",
      }],
      // `no-empty` continua ATIVO para if/for/while/function/switch. Só o
      // `catch {}` vazio é permitido -- é o idioma "tenta e ignora a falha"
      // (ex.: migração SQLite não-destrutiva, fallback de auth JWT->token,
      // limpeza de fixture de teste). É a opção que o próprio ESLint provê
      // para esse caso; não é desativar a regra.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
