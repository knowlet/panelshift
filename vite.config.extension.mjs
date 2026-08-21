import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(projectRoot, "extension"),
  publicDir: path.join(projectRoot, "extension", "public"),
  base: "./",
  plugins: [react()],
  worker: {
    format: "es",
  },
  build: {
    outDir: path.join(projectRoot, "extension-dist"),
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome116",
    rollupOptions: {
      input: {
        sidepanel: path.join(projectRoot, "extension", "sidepanel.html"),
        "ocr-sandbox": path.join(projectRoot, "extension", "ocr-sandbox.html"),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
