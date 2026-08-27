import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Fora do escopo deste lint (frontend Vite/React):
  //  - dist/            : build output
  //  - qrng-client-api/ : pacote Node/Express separado, com seu proprio gate
  //                       (`node --test` + verificacao de drift do OpenAPI).
  //                       Linta-lo com um flat config browser-only gerava ~120
  //                       falsos `no-undef` (require/module/process/Buffer/
  //                       describe...). Se ganhar lint proprio, sera aqui.
  //  - load-tests/      : scripts k6, executados pelo binario `k6` com globais
  //                       proprias (__ENV, http de "k6/http").
  globalIgnores(['dist', 'qrng-client-api/**', 'load-tests/**']),

  // Frontend React (browser).
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },

  // src/contexts/: co-locar `createContext()` + o Provider no mesmo arquivo e o
  // padrao idiomatico do React. `react-refresh/only-export-components` e uma
  // regra de ergonomia de HMR (Fast Refresh), sem efeito em correcao ou build --
  // ela permanece ATIVA em todo src/components/**, so nao se aplica aqui, onde
  // exportar o objeto de contexto ao lado do Provider e deliberado.
  {
    files: ['src/contexts/**/*.{js,jsx}'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },

  // Arquivos de configuracao e specs Playwright: rodam em Node, nao no browser.
  {
    files: ['*.{js,mjs}', 'e2e/**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
])
