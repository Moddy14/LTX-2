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
    watch: {
      // Release staging contains a complete Python environment. Watching it can
      // exhaust the host inotify budget and terminate both UI and API in dev/E2E.
      ignored: ["**/build/**", "**/release/**", "**/.venv/**"],
    },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        // The API enforces an exact loopback Host authority. Rewrite the
        // development proxy's UI-port Host to the configured API origin.
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: uiPort,
  },
});
