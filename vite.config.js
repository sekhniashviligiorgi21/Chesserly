import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    },
    proxy: {
      '/stats.js': {
        target: 'https://umami.is',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/stats.js/, '/script.js'),
      },
      '/api/send': {
        target: 'https://umami.is',
        changeOrigin: true,
      }
    }
  }
})
