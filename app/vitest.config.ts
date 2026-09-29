import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@/lib/feedbackTransport": path.resolve(__dirname, "./src/mocks/feedbackTransport.ts"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // Keep the per-test hard stop comfortably above `asyncUtilTimeout`
    // (setup.ts) so a chained findBy*/waitFor reports the testing-library
    // "unable to find" message instead of a bare vitest timeout.
    testTimeout: 15000,
    // Vitest owns the frontend/CLI-contract suites under src/. The Playwright
    // e2e specs under e2e/ are run by `npm run test:e2e` (real browser); exclude
    // them here so vitest does not try to collect @playwright/test files.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
    // Retries only on GitHub Actions, matching playwright.config.ts: CI alone
    // is not the signal (local_test_runner.py sets CI=true locally too), and a
    // local retry would hide a real flake instead of surfacing it for the
    // ledger (testing/flaky.yaml).
    retry: process.env.GITHUB_ACTIONS === "true" ? 1 : 0,
    // `flakyReporter.ts` records which tests needed a retry to pass, so the
    // ledger can flag them. NOTE: local_test_runner.py invokes vitest with
    // `--reporter=json`, which overrides this `reporters` array entirely (a
    // CLI --reporter flag replaces config reporters rather than adding to
    // them), so the flaky report is CI-only in practice.
    reporters: process.env.GITHUB_ACTIONS === "true" ? ["default", "./src/test/flakyReporter.ts"] : ["default"],
  },
});
