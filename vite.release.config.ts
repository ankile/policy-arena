import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'release-entry',
    transformIndexHtml: {order: 'pre', handler: (html, ctx) => ctx.path === '/index.html' ? readFileSync(resolve('release.html'), 'utf8') : html},
  }],
  resolve: {alias: [
    {find: /.*\/lib\/arenaClient$/, replacement: resolve('src/release/client.ts')},
    {find: './arenaClient', replacement: resolve('src/release/client.ts')},
    {find: './components/AuthControls', replacement: resolve('src/release/ReleaseLinks.tsx')},
  ]},
  publicDir: false,
  build: {rollupOptions: {input: {index: resolve('index.html'), overview: resolve('overview.html')}}, outDir: process.env.MULLIGAN_RELEASE_OUTPUT || '/tmp/mulligan-arena-build', emptyOutDir: true},
});
