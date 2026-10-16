import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The API runs on the local server (npm start, port 4173). `npm run dev` proxies /api to it.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null, // registered manually, only in secure contexts (HTTPS or localhost)
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Buz Cards',
        short_name: 'Buz Cards',
        description: 'Scan business cards and keep the contacts.',
        theme_color: '#0f4c5c',
        background_color: '#f6f7f9',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // App shell only. API data is never cached by the service worker (the server is the source of truth).
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { host: true, proxy: { '/api': 'http://127.0.0.1:4173' } },
  build: { outDir: 'dist', sourcemap: false },
});
