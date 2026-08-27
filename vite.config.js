import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",  // escutar em todas interfaces (acesso externo)
    port: 5180,        // porta livre
    strictPort: false, // se 5180 estiver ocupada, tenta a próxima
    proxy: {
      // FPGA precisa vir ANTES de /api para não ser capturado por /api
      "/api-fpga": {
        target: "http://127.0.0.1:18002",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-fpga/, ""),
      },
      // Backend principal (Express na porta 3001, já espera prefixo /api)
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
      // API cliente QRNG — gestão de tokens (porta 3010)
      // Espelha o nginx do servidor: /qrng/v1/ → localhost:3010/v1/
      "/qrng/v1": {
        target: "http://127.0.0.1:3010",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/qrng/, ""),
      },
    },
  },
  base: "/qrng",
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.js",
    globals: true,
    // qrng-client-api/ é um projeto Node separado com sua própria suíte
    // (node --test, supertest) — não faz parte dos testes do frontend.
    // e2e/ é a suíte Playwright (@playwright/test) — roda por `npm run test:e2e`,
    // nunca pelo vitest (test.describe do Playwright quebra fora do runner dele).
    exclude: ["**/node_modules/**", "qrng-client-api/**", "e2e/**", "physical-layer/**"],
  },
})
