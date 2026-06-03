import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

function saveEntrancesPlugin() {
  return {
    name: 'save-entrances',
    configureServer(server) {
      // POST /api/save-entrance  body: { feature: GeoJSON Feature }
      server.middlewares.use('/api/save-entrance', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const { feature } = JSON.parse(body);
            const p = resolve('./resources/entrances.geojson');
            let fc;
            try {
              fc = JSON.parse(readFileSync(p, 'utf8'));
            } catch {
              fc = { type: 'FeatureCollection', features: [] };
            }
            fc.features.push(feature);
            writeFileSync(p, JSON.stringify(fc, null, 2));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, total: fc.features.length }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e) }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), saveEntrancesPlugin()],
  publicDir: 'resources',
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    open: true,
    allowedHosts: true,
    hmr: { clientPort: 443, protocol: 'wss' },
    proxy: {
      '/accessmap-api': {
        target: 'https://stage.accessmap.app',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/accessmap-api/, '/api/v1/routing'),
        headers: {
          Referer: 'https://stage.accessmap.app/',
          Origin: 'https://stage.accessmap.app',
        },
      },
    },
  },
});
