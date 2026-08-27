import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Fora do escopo DESTE lint (frontend Vite/React):
  //  - dist/            : build output
  //  - qrng-client-api/ : pacote Node/Express separado, com eslint.config.js e
  //                       `npm run lint` PROPRIOS (job "qrng-client-api" do CI).
  //                       Nao e "ignorar silenciosamente": e lintado la, com
  //                       ambiente/regras de Node. Um flat config browser-only
  //                       aqui gerava ~120 falsos `no-undef`.
  globalIgnores(['dist', 'qrng-client-api/**']),

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
    files: ['*.{js,mjs}', 'e2e/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
    },
  },

  // load-tests/: scripts k6. Rodam pelo binario `k6` (nao Node), com globais
  // proprias (__ENV, __VU, __ITER, open) e modulos "k6/*". Lintados aqui --
  // codigo ativo, nao ignorado -- so com o ambiente certo. (Se um dia houver
  // um runner k6 no CI, pode virar job separado; hoje o gate e o lint.)
  {
    files: ['load-tests/**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.es2021,
        console: 'readonly',
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
        open: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
    },
  },
])
