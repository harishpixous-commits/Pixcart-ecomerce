import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The web app talks to the BFF. In dev Vite proxies so the browser sees one origin
// (no CORS in the happy path); in production the BFF serves the built assets itself.
const BFF = process.env.BFF_ORIGIN ?? 'http://127.0.0.1:8090';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // One source of truth for the wire contract: the UI imports the exact same
      // DTO declarations the BFF is typed against, so a field rename cannot drift
      // between the two. Type-only imports are erased at build time.
      '@contracts': fileURLToPath(new URL('../../contracts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BFF, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
