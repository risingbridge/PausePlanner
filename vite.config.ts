import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import pkg from './package.json' with { type: 'json' }

// https://vite.dev/config/
export default defineConfig({
  base: '/PausePlanner/',
  plugins: [react()],
  // package.json is the single source of truth for the version; it's shown
  // in the header so a deployed build can be matched to a tag at a glance.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
})
