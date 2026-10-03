import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // Publish the browser-local playground on previews, never the shared production site.
  build: mode === 'playground' || process.env.VERCEL_ENV === 'preview' ? {
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        playground: fileURLToPath(new URL('./sandbox/stage-review.html', import.meta.url)),
      },
    },
  } : undefined,
}))
