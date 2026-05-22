import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  publicDir: 'resources',
  optimizeDeps: {
    // onnxruntime-web ships native WASM — Vite must not pre-bundle it
    exclude: ['onnxruntime-web'],
  },
  server: {
    port: 5173,
    open: true,
  },
});
