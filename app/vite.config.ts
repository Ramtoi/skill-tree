import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import pkg from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Dev-server port. Overridable via ST_DEV_PORT so parallel git worktrees — and a
// Playwright run started next to an already-running `npm run dev` — don't fight
// over 1420. A junk value is called out rather than silently ignored: with
// `strictPort: true` a wrong port is a hard failure, so a typo must not look
// like the default quietly working.
function resolveDevPort(): number {
  // @ts-expect-error process is a nodejs global
  const raw = process.env.ST_DEV_PORT;
  if (raw === undefined || raw === "") return 1420;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.warn(
      `[skill-tree] ST_DEV_PORT=${JSON.stringify(raw)} is not a valid port — falling back to 1420.`,
    );
    return 1420;
  }
  return n;
}
const devPort = resolveDevPort();
// HMR steps by TWO, not one: two worktrees on ADJACENT ports (1420 and 1421)
// would otherwise collide, because the first one's HMR socket claims the second
// one's dev-server port.
const hmrPort = devPort + 2;

// Browser-only builds: when VISUAL_MOCK=1 (set by `npm run visual` for the
// screenshot harness and by `npm run build:preview` for the per-PR Vercel
// preview), swap the Tauri IPC modules for local mocks so the real React
// frontend boots in a plain browser with rich fake data. When the env var is
// absent these aliases are NOT added, so the default Tauri build path is
// unchanged.
// @ts-expect-error process is a nodejs global
const visualMock = process.env.VISUAL_MOCK === "1";
const mockAliases = visualMock
  ? {
      "@/lib/feedbackTransport": path.resolve(__dirname, "./src/mocks/feedbackTransport.ts"),
      "@tauri-apps/api/core": path.resolve(__dirname, "./src/mocks/tauriCore.ts"),
      "@tauri-apps/api/window": path.resolve(__dirname, "./src/mocks/tauriWindow.ts"),
      "@tauri-apps/plugin-opener": path.resolve(__dirname, "./src/mocks/tauriOpener.ts"),
    }
  : {};

export default defineConfig(async () => ({
  plugins: [react()],

  // Single version source of truth: package.json (kept in lockstep by
  // scripts/bump-version.sh). Surfaced to the UI as the __APP_VERSION__ global.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  resolve: {
    alias: {
      ...mockAliases,
      "@": path.resolve(__dirname, "./src"),
    },
  },

  clearScreen: false,
  server: {
    port: devPort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: hmrPort,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
