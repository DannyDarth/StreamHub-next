import { resolve } from "node:path";
import { defineConfig } from "vite";

// Tauri loads the built files from dist/ (and the dev server in `tauri dev`).
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        badge: resolve(import.meta.dirname, "badge.html"),
      },
    },
  },
});
