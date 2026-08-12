import { resolve } from "node:path";
import { defineConfig } from "vite";

const extensionRoot = resolve(__dirname, "browser-extension");

export default defineConfig({
  root: extensionRoot,
  base: "./",
  publicDir: resolve(extensionRoot, "public"),
  build: {
    target: "es2020",
    outDir: resolve(extensionRoot, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: resolve(extensionRoot, "popup.html"),
        "service-worker": resolve(extensionRoot, "src/service-worker.ts"),
        "content-script": resolve(extensionRoot, "src/content-script.ts"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
