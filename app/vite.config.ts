import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import pkg from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Visual-screenshot harness ONLY: when VISUAL_MOCK=1 (set by `npm run visual`),
// swap the Tauri IPC modules for local mocks so the real React frontend boots
// in a plain headless browser with rich fake data. When the env var is absent
// these aliases are NOT added, so the default Tauri build path is unchanged.
// @ts-expect-error process is a nodejs global
const visualMock = process.env.VISUAL_MOCK === "1";
const mockAliases = visualMock
  ? {
      "@tauri-apps/api/core": path.resolve(__dirname, "./src/mocks/tauriCore.ts"),
      "@tauri-apps/api/window": path.resolve(__dirname, "./src/mocks/tauriWindow.ts"),
      "@tauri-apps/plugin-opener": path.resolve(__dirname, "./src/mocks/tauriOpener.ts"),
    }
  : {};

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Single version source of truth: package.json (kept in lockstep by
  // scripts/bump-version.sh). Surfaced to the UI as the __APP_VERSION__ global.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      ...mockAliases,
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
