import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  renderWithProviders,
  sampleRegistry,
  primeRegistry,
  makeQueryClient,
  deferredInvoke,
} from "./helpers";
import { SkillEditor } from "@/screens/SkillEditor";
import { queryClient } from "@/lib/queryClient";
import type { DroppedSkill, Registry } from "@/types";

function setupSkillDocMock() {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "read_skill_document") {
      const { name } = (args as { name: string }) ?? { name: "" };
      return {
        name,
        description: sampleRegistry.skills[name]?.description ?? "",
        body: `# ${name}\nHello`,
      };
    }
    if (cmd === "check_python") return true;
    if (cmd === "hub_cmd") return { success: true, output: "{}" };
    return undefined;
  });
}

function renderEditor(initialRoute: string, registry: Registry = sampleRegistry) {
  const client = makeQueryClient();
  primeRegistry(client, registry);
  return renderWithProviders(
    <Routes>
      <Route path="/skill/:name" element={<SkillEditor />} />
    </Routes>,
    { client, initialRoute },
  );
}

beforeEach(setupSkillDocMock);
// A couple of tests below prime the app-singleton `queryClient` (their
// toggles read/write it directly — see the comment at their call sites) and
// never clear it, so `sampleRegistry` would otherwise leak into every later
// test in this file, including the dropped-upstream describe below.
beforeEach(() => {
  queryClient.clear();
});

describe("SkillEditor — hybrid ownership", () => {
  it("renders the external source banner for an externally managed skill", async () => {
    renderEditor("/skill/android-compose-ui");
    await waitFor(() =>
      expect(screen.getByText(/^External source$/i)).toBeInTheDocument(),
    );
    expect(screen.getAllByText("Duplicate as local").length).toBeGreaterThan(0);
    // The plaque is one column at the docked side-panel width: the headline
    // names the register, the chip names the source, and the actions are a
    // row of their own under the copy — never a column beside the text.
    const banner = document.querySelector(".source-banner.external-source-banner")!;
    expect(banner).not.toBeNull();
    const head = banner.querySelector(".source-banner-head")!;
    expect(head.textContent).toBe("External source");
    expect(banner.querySelector(".source-banner-chip .source-chip")?.textContent).toContain(
      "Org Skills",
    );
    const order = Array.from(banner.children).map((el) => el.className);
    expect(order.indexOf("source-banner-actions")).toBe(order.length - 1);
    expect(order.indexOf("source-banner-actions")).toBeGreaterThan(
      order.indexOf("source-banner-copy"),
    );
  });

  it("locks the markdown editor read-only for externally managed skills", async () => {
    const { container } = renderEditor("/skill/android-compose-ui");
    // R1 opens this skill on Preview by default — switch to Edit (still
    // offered, per R1) to reach the CodeMirror surface this test is about.
    await waitFor(() => screen.getByRole("tab", { name: "Edit" }));
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    // CodeMirror owns the edit surface; read-only ⇒ a non-editable .cm-content.
    await waitFor(() =>
      expect(container.querySelector(".code-area--edit .cm-content")).toBeTruthy(),
    );
    const content = container.querySelector(
      ".code-area--edit .cm-content",
    ) as HTMLElement | null;
    expect(content).toBeTruthy();
    expect(content!.getAttribute("contenteditable")).toBe("false");
  });

  // R1 — a source-managed skill opens on Preview (the markdown body is dead
  // weight to edit here; source sync owns the file). A local skill is
  // unchanged: Edit.
  it("opens an externally managed skill in Preview", async () => {
    renderEditor("/skill/android-compose-ui");
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("still opens a local skill in Edit", async () => {
    renderEditor("/skill/brainstorm");
    await waitFor(() => screen.getAllByText("brainstorm").length > 0);
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  // R1's load-bearing clause: the default fires ONCE per route, never again on
  // a later registry refetch — which produces a new `skill` object identity
  // and must not yank the user back to Preview after they picked Edit.
  it("never re-defaults to Preview after a registry refetch, once the user has switched modes", async () => {
    const client = makeQueryClient();
    primeRegistry(client, sampleRegistry);
    renderWithProviders(
      <Routes>
        <Route path="/skill/:name" element={<SkillEditor />} />
      </Routes>,
      { client, initialRoute: "/skill/android-compose-ui" },
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Preview" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );

    act(() => {
      primeRegistry(client, { ...sampleRegistry });
    });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });

  // R3 — the header's primary slot is empty for a read-only skill; "Duplicate
  // as local" moves to a soft button in the editor bar's headerActions,
  // before Export. The overflow must not list it a second time.
  it("moves Duplicate as local out of the header primary slot and into the editor bar for an external skill", async () => {
    const { container } = renderEditor("/skill/android-compose-ui");
    await waitFor(() =>
      expect(screen.getByText(/^External source$/i)).toBeInTheDocument(),
    );

    const headerPrimary = container.querySelector(".main-header-right")!;
    expect(headerPrimary.textContent).not.toContain("Duplicate as local");

    const barRight = container.querySelector(".doc-editor-bar-right")!;
    const dupInBar = Array.from(
      barRight.querySelectorAll("button"),
    ).find((b) => b.textContent?.includes("Duplicate as local"));
    expect(dupInBar).toBeTruthy();
    expect(dupInBar!.className).toContain("btn-soft");
    // Export still follows it in the same cluster.
    expect(barRight.textContent).toMatch(/Duplicate as local[\s\S]*Export/);

    // Overflow menu holds it in exactly one place — not a second copy here.
    const overflowButton = screen.getByTestId("overflow-trigger");
    fireEvent.click(overflowButton);
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByText(/Duplicate/)).toBeNull();
  });

  it("keeps Duplicate as local in the overflow only for a local skill (bar has just Export)", async () => {
    const { container } = renderEditor("/skill/brainstorm");
    await waitFor(() => screen.getAllByText("brainstorm").length > 0);
    const barRight = container.querySelector(".doc-editor-bar-right")!;
    expect(barRight.textContent).not.toContain("Duplicate as local");
    expect(barRight.textContent).toContain("Export");
  });

  it("does NOT render the banner for a locally managed skill", async () => {
    renderEditor("/skill/brainstorm");
    await waitFor(() => screen.getAllByText("brainstorm").length > 0);
    expect(screen.queryByText(/^External source$/i)).toBeNull();
    expect(screen.queryByText(/^Starter Pack$/i)).toBeNull();
  });

  // Bug fix: `readOnly` (source-managed) must not silently no-op USED BY —
  // equipping an external skill to a bundle/project is a normal, supported
  // action. Only the archive/forget page lock (`busy`) may gate it.
  it("still writes USED BY toggles for a read-only (source-managed) skill", async () => {
    // `useSkillBundleEquip` reads/writes the app's SINGLETON query client (see
    // ConnectionsPanel.test.tsx), not the local client `renderEditor` hands to
    // its provider — prime it too, or the toggle throws "unknown bundle"
    // before it ever reaches `hub_cmd`.
    primeRegistry(queryClient, sampleRegistry);
    renderEditor("/skill/android-compose-ui");
    await waitFor(() =>
      expect(screen.getByText(/^External source$/i)).toBeInTheDocument(),
    );
    const box = screen.getByRole("checkbox", {
      name: "Unequip android-compose-ui android",
    });
    fireEvent.click(box);
    await waitFor(() => {
      const call = vi
        .mocked(invoke)
        .mock.calls.find(
          ([cmd, args]) =>
            cmd === "hub_cmd" &&
            ((args as { args?: string[] } | undefined)?.args?.[0] === "bundle"),
        );
      expect(call).toBeTruthy();
      const cmdArgs = (call?.[1] as { args?: string[] } | undefined)?.args ?? [];
      expect(cmdArgs.slice(0, 2)).toEqual(["bundle", "update"]);
    });
  });

  // The archive/forget page lock IS the one thing that must gate USED BY's
  // writes — while it's engaged, a toggle must stay a no-op. There is no
  // existing way to reach `pageBusy` from outside the archive/forget flow, so
  // this exercises that flow directly on a read-only skill (its danger-zone
  // Archive button is offered regardless of `readOnly`).
  it("leaves USED BY toggles a no-op while the page is busy archiving", async () => {
    primeRegistry(queryClient, sampleRegistry);
    const gate = deferredInvoke(
      (cmd, args) =>
        cmd === "hub_cmd" &&
        (args as { args?: string[] } | undefined)?.args?.[0] === "archive",
    );
    renderEditor("/skill/android-compose-ui");
    await waitFor(() =>
      expect(screen.getByText(/^External source$/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive this skill" }));
    const confirmButton = await screen.findByRole("button", { name: "Archive" });
    fireEvent.click(confirmButton);
    // The page-lock (`data-busy`) engages as soon as the archive call is in
    // flight — before the hung `runHubCmd(["archive", ...])` ever settles.
    await waitFor(() =>
      expect(document.querySelector('[data-busy="true"]')).toBeTruthy(),
    );

    const box = screen.getByRole("checkbox", {
      name: "Unequip android-compose-ui android",
    });
    expect(box).toBeChecked();
    fireEvent.click(box);
    // Give any (wrongly-fired) toggle a tick to reach `invoke` before
    // asserting — wrapped in `act` since the no-op path resolves via a bare
    // microtask, outside `fireEvent`'s own `act` wrapper.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const bundleCall = vi
      .mocked(invoke)
      .mock.calls.find(
        ([cmd, args]) =>
          cmd === "hub_cmd" &&
          (args as { args?: string[] } | undefined)?.args?.[0] === "bundle",
      );
    expect(bundleCall).toBeUndefined();
    // `lockedReason` refuses the toggle in `isActionable()` before any state
    // is touched: no optimistic flip, no `synced`, no stuck override.
    expect(box).toBeChecked();
    expect(screen.queryByText("synced")).toBeNull();

    // Let the hung archive settle so the test doesn't leak a pending timer.
    await act(async () => {
      gate.resolve({ success: true, output: "{}" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});

// ─── Dropped upstream (source_missing) ───────────────────────────────────────

function droppedRegistry(): Registry {
  return {
    ...sampleRegistry,
    skills: {
      ...sampleRegistry.skills,
      diagnose: {
        version: "1.0.0",
        description: "Diagnose a failing build.",
        source: "~/.skill-hub/sources/design-system/worktree/skills/engineering/diagnose",
        type: "claude-skill",
        scope: "portable",
        upstream: "git@github.com:acme/design-system.git",
        managed: "external",
        origin: { source: "design-system", source_type: "git" },
        source_missing: true,
      },
    },
  };
}

const DIAGNOSE_ROW: DroppedSkill = {
  name: "diagnose",
  source: "design-system",
  source_name: "Design System",
  path: "skills/engineering/diagnose",
  ref: "b1c2d3e",
  ref_short: "b1c2d3e",
  last_seen_at: "2026-07-05T09:12:00+02:00",
  reason: "renamed",
  successor: {
    path: "skills/engineering/diagnosing-bugs",
    name: "diagnosing-bugs",
    registered_as: "diagnosing-bugs", similarity: 96,
  },
  equipped: { projects: [], bundles: [], remotes: [], cloud: [] },
  recoverable: true,
  skill_md: "---\nname: diagnose\n---\n\nOld body.\n",
};

function setupDroppedMock(row: DroppedSkill, registry: Registry = droppedRegistry()) {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "read_skill_document") {
      // A dropped skill never calls this — surface a distinct failure so a
      // regression that re-adds the call is loud, not silently blank.
      throw new Error("read_skill_document should not be called for a dropped skill");
    }
    if (cmd === "check_python") return true;
    // `staleTime: 0` (makeQueryClient) means `useRegistry` refetches in the
    // background even though `primeRegistry` already seeded the cache —
    // answer it so that refetch doesn't warn "Query data cannot be undefined".
    if (cmd === "read_registry") return registry;
    if (cmd === "hub_cmd") {
      const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
      if (cmdArgs[0] === "source" && cmdArgs[1] === "dropped") {
        return { success: true, output: JSON.stringify({ ok: true, skills: [row] }) };
      }
      return { success: true, output: "{}" };
    }
    return undefined;
  });
}

describe("SkillEditor — dropped upstream", () => {
  it("shows the DROPPED UPSTREAM pill, the renamed reason, and DroppedUpstreamBanner instead of ExternalSourceBanner", async () => {
    setupDroppedMock(DIAGNOSE_ROW);
    renderEditor("/skill/diagnose", droppedRegistry());

    await waitFor(() => expect(screen.getByText("DROPPED UPSTREAM")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("dropped-upstream-banner")).toBeInTheDocument());
    expect(screen.queryByText(/^External source$/i)).toBeNull();
    // Renamed + a registered successor → primary is "Open successor".
    expect(screen.getAllByRole("button", { name: "Open successor" }).length).toBeGreaterThan(0);
    expect(screen.getByText(/Renamed upstream to diagnosing-bugs/)).toBeInTheDocument();
  });

  it("a deleted skill's primary is Forget, not Open successor", async () => {
    setupDroppedMock({ ...DIAGNOSE_ROW, reason: "deleted", successor: null });
    renderEditor("/skill/diagnose", droppedRegistry());

    await waitFor(() => expect(screen.getByText("DROPPED UPSTREAM")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Open successor" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Forget" }).length).toBeGreaterThan(0);
  });

  it("renders the pinned-ref body read-only when content is available", async () => {
    setupDroppedMock(DIAGNOSE_ROW);
    const { container } = renderEditor("/skill/diagnose", droppedRegistry());

    // R1 opens a dropped skill on Preview by default too; switch to Edit
    // (still offered) to reach the CodeMirror surface this test is about.
    await waitFor(() => screen.getByRole("tab", { name: "Edit" }));
    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    await waitFor(() =>
      expect(container.querySelector(".code-area--edit .cm-content")).toBeTruthy(),
    );
    const content = container.querySelector(".code-area--edit .cm-content") as HTMLElement | null;
    expect(content!.getAttribute("contenteditable")).toBe("false");
    await waitFor(() => expect(content!.textContent).toContain("Old body."));
  });

  it("shows an EmptyState — never a blank editor — when the checkout has nothing left", async () => {
    setupDroppedMock({ ...DIAGNOSE_ROW, skill_md: null });
    renderEditor("/skill/diagnose", droppedRegistry());

    await waitFor(() =>
      expect(screen.getByText("Content is no longer in the checkout")).toBeInTheDocument(),
    );
  });

  it("the files section shows the one dropped line, not the generic list error", async () => {
    setupDroppedMock(DIAGNOSE_ROW);
    renderEditor("/skill/diagnose", droppedRegistry());

    await waitFor(() => expect(screen.getByTestId("skill-files-dropped")).toBeInTheDocument());
    expect(screen.queryByText(/Could not list this skill's files/)).toBeNull();
  });
});
