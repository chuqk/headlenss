import { defineConfig } from 'vite'
import { readFileSync } from 'fs'

const appJson = JSON.parse(readFileSync('./app.json', 'utf-8'))

export default defineConfig(({ command }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(appJson.version),
  },
  base: command === 'build' ? './' : '/',
  server: {
    host: true,
    port: 5177,
    allowedHosts: true,
  },
}))
