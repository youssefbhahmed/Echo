import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./supabase/functions/_shared', import.meta.url)) },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'ECHO — Discover beyond the algorithm',
        short_name: 'ECHO',
        description: 'Your personal cross-media discovery agent for videos, music, films, books and podcasts.',
        theme_color: '#0c0b10',
        background_color: '#0c0b10',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        categories: ['entertainment', 'music', 'books', 'lifestyle'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            // Artwork from content providers: cache-first, bounded.
            urlPattern: ({ url }) =>
              /(^|\.)(ytimg\.com|scdn\.co|image\.tmdb\.org|covers\.openlibrary\.org|tvmaze\.com)$/.test(url.hostname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'echo-artwork',
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
        // Never cache authenticated API calls in the service worker.
        navigateFallbackDenylist: [/^\/functions\//, /^\/auth\//, /^\/rest\//],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5173 },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    setupFiles: ['tests/unit/setup.ts'],
  },
});
