import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/client",
  build: {
    outDir: "../../dist-client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: true,
    proxy: { "/api": "http://localhost:54321" },
  },
});
