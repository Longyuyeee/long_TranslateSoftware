import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: true, // 监听所有地址
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
