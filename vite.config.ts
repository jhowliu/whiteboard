import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Reach the dev server from an iPad over `tailscale serve`.
    allowedHosts: ['.ts.net'],
  },
})
