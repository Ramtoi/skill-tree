import { defineConfig, devices } from "@playwright/test";

// Real-browser e2e for the Skill Tree frontend, driven against the mocked-Tauri
// dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). The same boot path the
// visual harness uses, so no Tauri runtime is required. NEVER touches ~/.claude.

// Kept in lockstep with vite.config.ts's `resolveDevPort`: ST_DEV_PORT lets
// parallel worktrees run e2e without colliding on 1420, and the spawned dev
// server inherits the same env so vite binds exactly where Playwright looks.
// A junk value must fall back the SAME way on both sides, and loudly —
// otherwise Playwright polls a port vite never bound and times out with no clue.
function resolveDevPort(): number {
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
const PORT = resolveDevPort();
// On CI the journeys run against the prebuilt VISUAL_MOCK bundle (see webServer
// below). Two things exist only on the dev server: `import.meta.env.DEV` routes
// such as /styleguide, and `/node_modules/.vite/deps/*` module URLs. Journeys
// that need them read this flag and skip with a reason instead of failing.
if (process.env.CI) process.env.ST_E2E_PREVIEW = "1";
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Retries only on GitHub Actions, never keyed on plain `CI` — local_test_runner.py
  // sets CI=true for local runs too, and a local retry would hide a real flake
  // instead of surfacing it for the ledger (testing/flaky.yaml).
  retries: process.env.GITHUB_ACTIONS === "true" ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["list"], ["json", { outputFile: "e2e-report/results.json" }]]
    : [["list"]],
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Locally the dev server is usually already warm (reuseExistingServer), so
  // routes are compiled before a journey visits them. On CI the server is
  // cold: `vite dev` compiles each route chunk on first request, and the
  // first journey to reach a route can lose the race against a swallowed
  // key press or a bounding-box read. Four different journeys failed once
  // each that way across four CI runs (2026-09-17). CI therefore serves the
  // prebuilt VISUAL_MOCK bundle, the same artifact the Vercel preview uses.
  webServer: {
    command: process.env.CI
      ? `npm run build:preview && npx vite preview --port ${PORT} --strictPort`
      : "npm run dev",
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { ...process.env, VISUAL_MOCK: "1", ST_DEV_PORT: String(PORT) },
  },
});
