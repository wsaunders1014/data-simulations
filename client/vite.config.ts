/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SharedArrayBuffer is only available on cross-origin-isolated pages.
// These two headers are what makes `crossOriginIsolated === true`.
// Production hosting (CDN / reverse proxy) must send them too.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// The data service runs on :8080. Proxying it keeps everything same-origin,
// which COEP requires and which mirrors a production reverse-proxy setup.
const DATA_SERVICE = process.env.DATA_SERVICE ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    headers: isolationHeaders,
    proxy: {
      '/api': DATA_SERVICE,
      '/ws': { target: DATA_SERVICE.replace(/^http/, 'ws'), ws: true },
    },
  },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
