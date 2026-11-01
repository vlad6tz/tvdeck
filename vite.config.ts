import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri v2 expects a static frontend on port 1420 (see src-tauri/tauri.conf.json)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  clearScreen: false,
  build: {
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
  },
});
