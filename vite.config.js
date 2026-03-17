import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: "::",       // escutar em todas interfaces (acesso externo)
    port: 5173,       // porta diferente de 8080 (outro projeto) e 3001 (backend)
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
    },
  },
  base: "/",
})
