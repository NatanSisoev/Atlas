// Build and dev server for the Atlas web client (Svelte 5 + Vite). Run from the repo root:
//   npm run build   -> web/dist (served by `atlas serve` at "/")
//   npm run dev     -> Vite on :5173, proxying /api, /media and /board to a running atlas server
//                      (ATLAS_URL, default http://127.0.0.1:5180)
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const atlasUrl = process.env.ATLAS_URL || 'http://127.0.0.1:5180';

const PAPER = '#F7F6F2';

export default defineConfig({
  root: webRoot,
  base: '/',
  publicDir: 'public',
  resolve: {
    alias: {
      $model: `${repoRoot}model`,
      $fonts: `${repoRoot}node_modules/@fontsource-variable`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    fs: { allow: [repoRoot] },
    proxy: {
      '/api': atlasUrl,
      '/media': atlasUrl,
      '/board': atlasUrl,
    },
  },
  plugins: [
    svelte(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: 'script', // registerSW.js file, no inline script (CSP script-src 'self')
      manifestFilename: 'manifest.webmanifest',
      includeManifestIcons: false, // the icons are already in globPatterns (no duplicate precache entries)
      manifest: {
        id: '/',
        name: 'Atlas',
        short_name: 'Atlas',
        description: 'Our photos and videos, read as a book.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: PAPER,
        theme_color: PAPER,
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{html,js,css,woff2,png}'], // the manifest is added by the plugin
        globIgnores: ['sw.js'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
});
