/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Sur GitHub Pages, l'appli est servie sous https://<pseudo>.github.io/gravel-app/
 * Ce chemin doit correspondre EXACTEMENT au nom du dépôt GitHub.
 * En local (npm run dev), on reste à la racine "/".
 */
const REPO_BASE = '/gravel-app/';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? REPO_BASE : '/',
  plugins: [
    VitePWA({
      // "prompt" : une nouvelle version n'est installée que si l'utilisateur
      // appuie sur "Mettre à jour". Évite un rechargement en pleine sortie.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Gravel Compagnon',
        short_name: 'Gravel Compagnon',
        description: 'Itinéraires GPX, suivi GPS et plan nutrition pour le vélo gravel.',
        lang: 'fr',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#ffffff',
        theme_color: '#1b3a2b',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // On met en cache l'appli elle-même (pas les tuiles de carte : leurs
        // conditions d'utilisation interdisent le pré-téléchargement).
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}));
