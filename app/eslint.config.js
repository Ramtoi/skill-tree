import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

const FOCUS_MSG =
  "Timer-based focus races React commits; use useFocusAfterCommit.";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src-tauri/**", "visual/out/**", "visual/proof/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Browser runtime: the app itself, plus its browser-context test/mock helpers.
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
  },
  {
    // Node runtime: config files and Playwright e2e specs.
    files: ["*.config.{js,ts}", "e2e/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.node },
  },
  {
    // Node runtime, but these scripts also embed browser-context closures
    // (page.addInitScript/page.evaluate) that ESLint parses as plain top-level
    // code — so both global sets apply to the whole file.
    files: ["visual/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // The three click-handling rules this change exists to enforce. All 35
      // offender sites (KNOWN_OFFENDERS in clickableA11y.test.ts, now empty)
      // are converted, but these stay "warn" rather than "error" on purpose:
      // once real ESLint runs (it never had in this repo before Slice A),
      // role="dialog"/"menu"/"option" + a click-sink handler still trips
      // click-events-have-key-events and no-noninteractive-element-
      // interactions even on already-accessible composite widgets — every
      // converted site here got a documented eslint-disable-next-line for
      // that, but repo-wide there are also PRE-EXISTING sites in files
      // outside S9's scope (Modal.tsx, ResizableSplit.tsx, ResourceRow.tsx,
      // Toast.tsx, screens/project/AvailableSkillsPanel.tsx,
      // screens/project/EquippedSkillsGrid.tsx — see the PR body) that would
      // also start failing the build on the flip. The plan explicitly
      // sanctions keeping these three at "warn" for exactly this situation:
      // "the vitest gate [clickableA11y.test.ts, A11Y_STRICT=1] is the real
      // gate either way." Flipping to "error" is a good follow-up, scoped to
      // those 6 files.
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      // Everything else below is demoted to "warn" per the S9 plan (measured
      // at A4: a pre-existing baseline, not a regression to chase down in an
      // a11y change).
      "jsx-a11y/no-autofocus": "warn",
      "jsx-a11y/label-has-associated-control": "warn",
      "jsx-a11y/interactive-supports-focus": "warn",
      "jsx-a11y/role-supports-aria-props": "warn",
      "jsx-a11y/no-noninteractive-tabindex": "warn",
      "jsx-a11y/aria-activedescendant-has-tabindex": "warn",
      "jsx-a11y/role-has-required-aria-props": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-fallthrough": "warn",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@tauri-apps/api/core",
              importNames: ["invoke"],
              message: "Import invoke from @/lib/ipc (keeps the in-flight counter accurate).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/ipc.ts", "src/test/**", "src/mocks/**"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // A `setTimeout(0)`/bare `requestAnimationFrame` queued right after a
    // state update can run BEFORE React commits that update to the DOM, so
    // `.focus()` inside it silently no-ops on a still-disabled or
    // still-unmounted element and is never retried (finding A,
    // SkillClassificationSection). `useFocusAfterCommit` runs after every
    // commit instead and keeps retrying until the target is actually
    // focusable.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/test/**", "src/mocks/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name=/^(setTimeout|requestAnimationFrame)$/] CallExpression[callee.property.name=/^focus/]",
          message: FOCUS_MSG,
        },
        {
          selector:
            "CallExpression[callee.name=/^(setTimeout|requestAnimationFrame)$/] CallExpression[callee.name=/^focus/]",
          message: FOCUS_MSG,
        },
        {
          selector:
            "CallExpression[callee.object.name='window'][callee.property.name=/^(setTimeout|requestAnimationFrame)$/] CallExpression[callee.property.name=/^focus/]",
          message: FOCUS_MSG,
        },
      ],
    },
  },
);
