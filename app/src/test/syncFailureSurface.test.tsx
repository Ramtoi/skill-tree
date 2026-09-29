import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { useRunSync } from "@/hooks/useRunSync";
import { useAppStore } from "@/store";
import { Processes } from "@/store/processes";
import { trackProcess } from "@/lib/trackProcess";
import { runHubCmd } from "@/lib/hubCmd";
import { errorDetail } from "@/lib/cliOutput";
import { ProcessTray } from "@/components/loading/ProcessTray";

// ─── The real failure this suite pins ────────────────────────────────────────
// `hub sync` fails registry validation. It paints advisory warnings on stdout
// in yellow and the ACTUAL error on stderr in bold red. The app used to show
// the first stdout line (a warning), with ANSI escapes intact, above a "log"
// holding nothing but a client-side breadcrumb.
const E = String.fromCharCode(27);

const SYNC_STDOUT = [
  `${E}[33m!${E}[0m design-an-interface: missing SKILL.md at ~/.skill-hub/skills/design-an-interface/SKILL.md`,
  "",
].join("\n");

const SYNC_STDERR = [
  `${E}[1m${E}[31mSkill registry validation failed:${E}[0m`,
  "  - qa-2: frontmatter name is 'qa' in ~/.skill-hub/skills/qa-2/SKILL.md; must match registry key to avoid collisions",
  "",
  "Fix the duplicate/mismatched skill definitions in ~/.skill-hub before running sync.",
  "",
].join("\n");

const FAILING_SYNC = {
  success: false,
  output: SYNC_STDOUT + SYNC_STDERR,
  stdout: SYNC_STDOUT,
  stderr: SYNC_STDERR,
};

// hub.py's DOMINANT failure shape: everything on stdout, stderr EMPTY. `fail()`
// prints to stdout at 222 call sites and all of `cmd_sync` does too, including
// the terminal "✗ sync completed with danger findings".
const SYNC_STDOUT_ONLY = [
  `${E}[1mSyncing registry → agent folders${E}[0m`,
  "",
  `  ${E}[32m✓${E}[0m example-app: 6 skills → .claude/skills`,
  `  ${E}[33m!${E}[0m moon-base: 'qa' reaches no installed harness — skipped`,
  "",
  `${E}[1m${E}[31m✗ sync completed with danger findings${E}[0m`,
  "",
].join("\n");

const FAILING_SYNC_STDOUT_ONLY = {
  success: false,
  output: SYNC_STDOUT_ONLY,
  stdout: SYNC_STDOUT_ONLY,
  stderr: "",
};

function mockSync(result: unknown) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "hub_cmd") return result;
    return undefined;
  });
}

function reset() {
  for (const p of Processes.list()) Processes.dismiss(p.id);
  useAppStore.setState({ toasts: [], syncStatus: "idle" });
}

// Minimal harness for the hook — the StatusBar/palette path is toast-only.
function SyncButton() {
  const runSync = useRunSync();
  return (
    <button type="button" onClick={() => void runSync()}>
      Sync now
    </button>
  );
}

// Minimal harness for the screen path — the ScreenHeader Sync buttons in
// SkillLibrary / ProjectWorkspace wrap the same call in a process card.
function TrackedSyncButton() {
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void trackProcess(
            { title: "Registry sync", body: "writing .claude / .agents", kind: "local" },
            () => runHubCmd(["sync"]),
            { successBody: "registry aligned", retry: () => {} },
          ).catch(() => {})
        }
      >
        Sync
      </button>
      <ProcessTray />
    </>
  );
}

// Minimal harness for ProjectWorkspace's equip toasts: `runHubCmd` + the same
// `errorDetail(err).headline` those `toast.error` bodies now use.
function EquipButton() {
  const addToast = useAppStore((s) => s.addToast);
  return (
    <button
      type="button"
      onClick={() =>
        void runHubCmd(["enable", "design-an-interface", "--project", "example-app"]).catch(
          (err) =>
            addToast("error", `Couldn't equip skill — ${errorDetail(err).headline}`),
        )
      }
    >
      Equip
    </button>
  );
}

describe("failed sync — toast path (StatusBar drawer / palette)", () => {
  beforeEach(reset);

  it("headlines the real error, ANSI-stripped, not the stdout warning", async () => {
    mockSync(FAILING_SYNC);
    render(<SyncButton />);
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));

    await waitFor(() =>
      expect(useAppStore.getState().toasts).toHaveLength(1),
    );
    const toast = useAppStore.getState().toasts[0];
    expect(toast.kind).toBe("error");
    expect(toast.title).toBe("Couldn't sync");
    expect(toast.body).toBe(
      "Skill registry validation failed: qa-2: frontmatter name is 'qa' in ~/.skill-hub/skills/qa-2/SKILL.md; must match registry key to avoid collisions",
    );
    expect(toast.body).not.toContain(E);
    expect(toast.body).not.toContain("design-an-interface");
    expect(useAppStore.getState().syncStatus).toBe("error");
  });

  it("never reports a green success tick as the error", async () => {
    // `cmd_enable` prints "✓ enabled 'x' for 'y'." and only THEN runs the
    // auto-sync that can fail (hub.py 7292 → 7294), so stdout OPENS with a
    // success line and stderr is empty. Taking the first stdout line — as the
    // app used to — told the user their successful equip was the error.
    const stdout = [
      `${E}[32m✓${E}[0m enabled 'design-an-interface' for 'example-app'.`,
      `${E}[1mSyncing registry → agent folders${E}[0m`,
      `  ${E}[33m!${E}[0m example-app: legacy-notes has no SKILL.md — skipped`,
      "no such project: 'ghost-app' referenced by bundle 'android'",
      "",
    ].join("\n");
    mockSync({ success: false, output: stdout, stdout, stderr: "" });

    render(<EquipButton />);
    await userEvent.click(screen.getByRole("button", { name: "Equip" }));

    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    const toast = useAppStore.getState().toasts[0];
    expect(toast.title).toBe("Couldn't equip skill");
    expect(toast.body).not.toContain("✓");
    expect(toast.body).not.toContain("enabled 'design-an-interface'");
    expect(toast.body).toBe(
      "no such project: 'ghost-app' referenced by bundle 'android'",
    );
  });

  it("headlines the ✗ tick of a stdout-only sync failure in the toast too", async () => {
    mockSync(FAILING_SYNC_STDOUT_ONLY);
    render(<SyncButton />);
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));

    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1));
    expect(useAppStore.getState().toasts[0].body).toBe(
      "✗ sync completed with danger findings",
    );
  });

  it("leaves the quiet success path alone", async () => {
    mockSync({ success: true, output: "", stdout: "", stderr: "" });
    render(<SyncButton />);
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));

    await waitFor(() =>
      expect(useAppStore.getState().syncStatus).toBe("synced"),
    );
    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("success");
    expect(toasts[0].title).toBe("Sync complete");
  });
});

describe("failed sync — process-card path (screen Sync buttons)", () => {
  beforeEach(reset);

  it("shows the real error on the card and the whole hub output in the log", async () => {
    mockSync(FAILING_SYNC);
    render(<TrackedSyncButton />);
    await userEvent.click(screen.getByRole("button", { name: "Sync" }));

    // Card face: the actual error, ANSI-free.
    const body = await screen.findByText(/Skill registry validation failed/);
    expect(body.textContent).toContain("qa-2");
    expect(body.textContent).not.toContain(E);

    // ONE log control, and it is not the old "See log"/"collapse log" pair.
    const logControls = screen.getAllByRole("button", { name: /log/i });
    expect(logControls).toHaveLength(1);

    await userEvent.click(logControls[0]);
    expect(screen.getAllByRole("button", { name: /log/i })).toHaveLength(1);

    // Log: the client breadcrumb + every line hub printed, both streams, in
    // order, ANSI-stripped — not a lone "+0.0s writing .claude" line.
    expect(screen.getByText("writing .claude / .agents")).toBeInTheDocument();
    expect(
      screen.getByText(/design-an-interface: missing SKILL.md/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Fix the duplicate\/mismatched skill definitions/),
    ).toBeInTheDocument();
    const lines = document.querySelectorAll(".lds-proc-log-line");
    expect(lines.length).toBe(5);
    expect(document.body.textContent).not.toContain(E);
  });

  it("renders no log chrome when the failure carried no command output", async () => {
    mockSync({ success: false, output: "", stdout: "", stderr: "" });
    render(<TrackedSyncButton />);
    await userEvent.click(screen.getByRole("button", { name: "Sync" }));

    // A silent exit says so — a bare "hub sync" would read like a line the
    // command actually printed.
    await screen.findByText("hub sync exited non-zero (no output)");
    expect(screen.queryByRole("button", { name: /log/i })).toBeNull();
    expect(document.querySelector(".lds-proc-log")).toBeNull();
  });

  it("headlines the ✗ tick of a stdout-only failure (hub.py's dominant shape)", async () => {
    mockSync(FAILING_SYNC_STDOUT_ONLY);
    render(<TrackedSyncButton />);
    await userEvent.click(screen.getByRole("button", { name: "Sync" }));

    const body = await screen.findByText("✗ sync completed with danger findings");
    expect(body.className).toContain("lds-proc-body");
    // Neither the leading banner nor an intermediate green tick may win.
    expect(body.textContent).not.toContain("Syncing registry");
    expect(body.textContent).not.toContain("✓");

    // The whole narration is still one click away.
    await userEvent.click(screen.getByRole("button", { name: /see log/i }));
    expect(
      screen.getByText("Syncing registry → agent folders"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/example-app: 6 skills/),
    ).toBeInTheDocument();
  });

  it("keeps a successful sync quiet — no log affordance on the success card", async () => {
    mockSync({ success: true, output: "", stdout: "", stderr: "" });
    render(<TrackedSyncButton />);
    await userEvent.click(screen.getByRole("button", { name: "Sync" }));

    await screen.findByText("registry aligned");
    expect(screen.queryByRole("button", { name: /log/i })).toBeNull();
  });
});
