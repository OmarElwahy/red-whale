// Vite dev server for the UI (docs/architecture.md §2). Localhost only (CLAUDE.md rule 8).
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const API = 'http://127.0.0.1:4100';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // changeOrigin stays off: the API accepts Host 127.0.0.1:5173 / localhost:5173 and our Origin,
    // so its DNS-rebinding check keeps working through the proxy. ws: true is for /api/ws.
    proxy: { '/api': { target: API, ws: true } },
  },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
});
