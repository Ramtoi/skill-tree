import { test, expect, WIDTH, type Page } from "./fixtures";

// Skill references across every host — the skill editor, harness doc,
// project Agent Docs, snippet edit + create, and sub-agent — driven against
// the mocked-Tauri dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts).
// NEVER touches ~/.claude.
//
// Every host reuses the SAME hook, component and stylesheet the skill editor
// uses (`useSkillRefs` / `SkillRefsSection` / `styles/skill-refs.css`), so
// this table proves the wiring on each surface. The mechanics themselves —
// decoration, hover card, ⌘-click, preview link — stay pinned by
// e2e/skill-refs.journey.spec.ts, which this file does not edit.
//
// Mock content: rt-android-expert's SKILL.md body, the claude-code global
// doc, every `read_agent_doc` response, the android-conventions snippet, and
// the code-reviewer sub-agent all mention `code-review` (a backtick span).
// See src/mocks/tauriCore.ts and src/mocks/tauriSubagents.ts.

test.use({ viewport: { width: WIDTH.wide, height: 900 } });

type Host = {
  host: string;
  trigger: string;
  restore: string;
  route: string;
  prepare?: (page: Page) => Promise<void>;
  open: (page: Page) => Promise<void>;
  backLabel: string;
  back: RegExp;
  check?: (page: Page) => Promise<void>;
};

async function openSkillRefToken(page: Page) {
  const token = page.locator('.cm-skill-ref[data-ref="code-review"]').first();
  await expect(token).toBeVisible();
  // ControlOrMeta: the platform's reference-open modifier (Control on
  // Linux, Meta on macOS); the handler accepts both.
  await token.click({ modifiers: ["ControlOrMeta"] });
}

const HOSTS: Host[] = [
  {
    host: "skill editor",
    trigger: "⌘-click on a reference",
    restore: "returns to rt-android-expert",
    route: "/#/skill/rt-android-expert",
    open: async (page) => {
      await expect(page.locator(".doc-editor-shell")).toBeVisible();
      await openSkillRefToken(page);
    },
    backLabel: "Back to rt-android-expert",
    back: /#\/skill\/rt-android-expert$/,
  },
  {
    host: "harness doc",
    trigger: "⌘-click",
    restore: "returns to the doc",
    route: "/#/harness/claude-code/doc",
    open: async (page) => {
      await expect(page.locator(".doc-editor-shell")).toBeVisible();
      await openSkillRefToken(page);
    },
    backLabel: "Back to Claude Code",
    back: /#\/harness\/claude-code\/doc$/,
  },
  {
    host: "agent docs",
    trigger: "a strip row",
    restore: "re-selects docs/agent/rules.md",
    route: "/#/project/moon-base?tab=agent-docs",
    prepare: async (page) => {
      await expect(page.locator(".agent-docs-map")).toBeVisible();
      // Select a nested file (unique in the tree, so the locator can never
      // match a different "CLAUDE.md"/"AGENTS.md" row) — proves the strip
      // follows the SELECTED buffer, not just whichever file loads first.
      const rules = page.locator(".ad-file", {
        has: page.locator('.ad-file-name:text-is("rules.md")'),
      });
      await rules.click();
      await expect(page.locator(".ad-doc-name")).toHaveText(
        "docs/agent/rules.md",
      );
    },
    open: async (page) => {
      const strip = page.locator('[data-testid="agent-docs-refs-strip"]');
      await expect(strip).toBeVisible();
      await strip.locator('[data-testid="skill-ref-row-out-code-review"]').click();
    },
    backLabel: "Back to moon-base",
    back: /#\/project\/moon-base\?tab=agent-docs$/,
    check: async (page) => {
      await expect(page.locator(".ad-doc-name")).toHaveText(
        "docs/agent/rules.md",
      );
    },
  },
  {
    host: "snippet edit",
    trigger: "⌘-click on a reference",
    restore: "returns to the snippet",
    route: "/#/snippet/android-conventions",
    open: async (page) => {
      await expect(page.locator(".doc-editor-shell")).toBeVisible();
      await openSkillRefToken(page);
    },
    backLabel: "Back to android-conventions",
    back: /#\/snippet\/android-conventions$/,
  },
  {
    host: "snippet create",
    trigger: "⌘-click on a reference with no confirm",
    restore: "keeps the draft",
    route: "/#/snippet/new",
    open: async (page) => {
      const cm = page.locator(".snip-code .cm-content");
      await expect(cm).toBeVisible();

      await cm.click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("Use `code-review` first.");

      await openSkillRefToken(page);

      // No confirm dialog — a reference click bypasses the unsaved-draft
      // guard (F11); the draft rides home in the back target's `restore`
      // instead.
      await expect(page.getByRole("dialog")).toHaveCount(0);
    },
    backLabel: "Back to New snippet",
    back: /#\/snippet\/new$/,
    check: async (page) => {
      // The typed body is still in the editor — the round trip is lossless.
      await expect(page.locator(".snip-code .cm-content")).toContainText(
        "Use `code-review` first.",
      );
    },
  },
  {
    host: "sub-agent",
    trigger: "⌘-click on a reference",
    restore: "re-opens code-reviewer",
    route: "/#/harness/claude-code",
    prepare: async (page) => {
      await page.getByText("code-reviewer", { exact: true }).click();
      await expect(page.locator(".doc-editor-body .cm-content")).toBeVisible();
    },
    open: async (page) => {
      await openSkillRefToken(page);
    },
    backLabel: "Back to code-reviewer",
    // The `?agent=code-reviewer` deep link the back target carries re-opens
    // the editor on that agent (`SubagentManager`'s existing `?agent=`
    // consumer) — a fresh mount of the harness screen, not a
    // component-state return, so this proves the deep link, not just
    // leftover state.
    back: /#\/harness\/claude-code/,
    check: async (page) => {
      await expect(
        page.getByRole("button", { name: /Rename agent name/i }),
      ).toHaveText("code-reviewer");
    },
  },
];

for (const row of HOSTS) {
  test(`${row.host}: ${row.trigger} opens code-review, and back ${row.restore}`, async ({
    page,
  }) => {
    await page.goto(row.route);
    if (row.prepare) await row.prepare(page);
    await row.open(page);

    await expect(page).toHaveURL(/#\/skill\/code-review$/);
    const back = page.locator(".header-back");
    await expect(back).toHaveAccessibleName(row.backLabel);
    await back.click();

    await expect(page).toHaveURL(row.back);
    if (row.check) await row.check(page);
  });
}
