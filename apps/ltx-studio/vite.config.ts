import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const uiPort = Number.parseInt(process.env.LTX_STUDIO_UI_PORT ?? "4317", 10);
const apiPort = Number.parseInt(process.env.LTX_STUDIO_PORT ?? "4318", 10);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: uiPort,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
  preview: {
    host: "127.0.0.1",
    port: uiPort,
  },
});
