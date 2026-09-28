import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'web',
  base: '/',
  build: {
    outDir: '../web-dist',
    emptyOutDir: true,
    sourcemap: true,
  },
})
