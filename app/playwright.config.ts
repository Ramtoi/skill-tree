import { defineConfig, devices } from "@playwright/test";

// Real-browser e2e for the Skill Tree frontend, driven against the mocked-Tauri
// dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). The same boot path the
// visual harness uses, so no Tauri runtime is required. NEVER touches ~/.claude.

const PORT = 1420;
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
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
  webServer: {
    command: "npm run dev",
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ...process.env, VISUAL_MOCK: "1" },
  },
});
