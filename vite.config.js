import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  build: { chunkSizeWarningLimit: 1500 },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'icons/icon.svg'],
      manifest: {
        name: 'Flight Companion',
        short_name: 'Flight Companion',
        description: "See what's below your window, even in flight mode.",
        theme_color: '#070b14',
        background_color: '#070b14',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,json,webmanifest,wasm}'],
        globIgnores: ['sw-bgfetch.js', 'places/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        importScripts: ['sw-bgfetch.js'],
        // place photos: saved with the flight into the tile cache, served from it offline
        runtimeCaching: [{
          urlPattern: /^https:\/\/[a-z]+\.wikimedia\.org\//,
          handler: 'CacheFirst',
          // only full (CORS) responses; the save step stores those
          options: { cacheName: 'fw-tiles-v1', cacheableResponse: { statuses: [200] } },
        }],
      },
    }),
  ],
});
