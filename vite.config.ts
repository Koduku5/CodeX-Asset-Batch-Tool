import path from "node:path"
import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const projectRoot = path.dirname(fileURLToPath(import.meta.url))
const backendTarget = "http://127.0.0.1:4174"

export default defineConfig({
  root: path.resolve(projectRoot, "src/ui"),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "src/ui"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": backendTarget,
      "/desktop": backendTarget,
      "/health": backendTarget,
      "/shutdown": backendTarget,
    },
  },
  build: {
    outDir: path.resolve(projectRoot, "dist/renderer"),
    emptyOutDir: true,
    sourcemap: process.env.KA_BUILD_SOURCEMAP === "1",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined
          if (id.includes("lucide-react")) return "icons"
          if (id.includes("@radix-ui")) return "radix-vendor"
          if (id.includes("react") || id.includes("scheduler")) return "react-vendor"
          return "vendor"
        },
      },
    },
  },
})
