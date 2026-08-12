import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { resolve } from 'path';

// Browsers only expose navigator.mediaDevices in a secure context. Because this
// server binds 0.0.0.0, opening the printed "Network" URL (http://192.168.x.x)
// gives a page with no camera API at all — getUserMedia is not merely blocked,
// it is absent. http://localhost is exempt, so the Local URL always works.
//
// For testing on a phone or tablet over the LAN, run:  VITE_HTTPS=1 npm run dev
// (needs `npm i -D @vitejs/plugin-basic-ssl`; you must accept the self-signed
// certificate warning once per device).
async function httpsPlugins() {
  if (!process.env.VITE_HTTPS) return [];
  try {
    const { default: basicSsl } = await import('@vitejs/plugin-basic-ssl');
    return [basicSsl()];
  } catch {
    console.warn(
      '\n[vite] VITE_HTTPS=1 but @vitejs/plugin-basic-ssl is not installed.\n' +
      '       Run: npm i -D @vitejs/plugin-basic-ssl\n' +
      '       Continuing over http:// — the camera will only work on http://localhost.\n',
    );
    return [];
  }
}

// GitHub Pages hard-limits any single file to 100 MB, and `publicDir:
// 'resources'` copies that whole folder into dist/ verbatim — including the
// ~200 MB OpenSidewalks extract, which would make the artifact unpublishable
// (and cannot be committed to a repo in the first place).
//
// Rather than fail deep inside the upload step, prune oversized files after the
// copy and say exactly what was dropped. Point VITE_BUILDINGS_URL at an
// external host if you need the buildings layer on a deployed build.
const PAGES_MAX_FILE_BYTES = 100 * 1024 * 1024;

function pruneOversizedAssets({ maxBytes = PAGES_MAX_FILE_BYTES } = {}) {
  return {
    name: 'prune-oversized-assets',
    apply: 'build',
    closeBundle() {
      const dist = resolve('./dist');
      if (!existsSync(dist)) return;

      const dropped = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = resolve(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          const { size } = statSync(full);
          if (size > maxBytes) {
            rmSync(full);
            dropped.push([full.replace(dist + '/', '').replace(dist + '\\', ''), size]);
          }
        }
      };
      walk(dist);

      if (dropped.length) {
        console.warn(
          `\n[build] Dropped ${dropped.length} file(s) over ` +
          `${(maxBytes / 1024 / 1024).toFixed(0)} MB — GitHub Pages will not serve them:`,
        );
        for (const [name, size] of dropped) {
          console.warn(`        ${name}  (${(size / 1024 / 1024).toFixed(0)} MB)`);
        }
        console.warn('        Host these externally and wire them up via env vars.\n');
      }
    },
  };
}

export default defineConfig(async () => ({
  // Project Pages serve from https://<user>.github.io/<repo>/, so assets need
  // that prefix. The workflow sets VITE_BASE; local builds stay at '/'.
  base: process.env.VITE_BASE || '/',
  plugins: [
    react(),
    pruneOversizedAssets(),
    ...(await httpsPlugins()),
  ],
  publicDir: 'resources',
  build: {
    rollupOptions: {
      input: {
        // Mapbox-driven tactile pin grid
        main: resolve('index.html'),
        // Generalized "any Audiom map" tactile explorer
        audiom: resolve('audiom.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    open: true,
    allowedHosts: true,
    // Only use the tunnel-style HMR socket when actually behind an HTTPS tunnel.
    // On plain http://localhost:5173 this must stay default or the client tries
    // wss://localhost and the page silently loses its dev connection.
    hmr: process.env.VITE_TUNNEL ? { clientPort: 443, protocol: 'wss' } : true,
    proxy: {
      // Local LLM router. One target, not three: the llama.cpp router serves
      // every tier from a single port and selects between them with the OpenAI
      // `model` field ("l1" embeddings, "l3" reasoning).
      //
      // Proxying rather than calling the server directly keeps the browser on
      // the same origin — the server sets CORS to '*' and has no API key, so it
      // must never be reachable from a page directly.
      //
      // Default target is loopback because the Mac runs the daemon locally. When
      // developing against it from another machine, forward the port first
      //     ssh -L 8081:127.0.0.1:8081 <mac>
      // and leave this alone, or set VITE_LLM_TARGET.
      '/llm': {
        target: process.env.VITE_LLM_TARGET || 'http://127.0.0.1:8081',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/llm/, ''),
      },
    },
  },
}));
