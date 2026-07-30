import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(() => {
  const serverTarget = process.env.LLMCRAFT_DEV_SERVER_URL ?? "http://localhost:3101";

  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, "index.html"),
          transcript: path.resolve(__dirname, "transcript.html"),
          diagnostics: path.resolve(__dirname, "diagnostics.html"),
        },
      },
    },
    server: {
      port: 3100,
      proxy: {
        "/api": {
          target: serverTarget,
        },
        "/ws": {
          target: serverTarget,
          ws: true,
        },
      },
    },
  };
});
