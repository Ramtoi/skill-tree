import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProgressBar } from "@/components/loading/ProgressBar";
import { LoadingButton } from "@/components/loading/LoadingButton";
import { ProcessCard } from "@/components/loading/ProcessCard";
import { ProcessTray } from "@/components/loading/ProcessTray";
import { StatusBarWorking, useRunningCount } from "@/components/loading/StatusBarWorking";
import { Processes, type Process } from "@/store/processes";

function resetProcesses() {
  for (const p of Processes.list()) Processes.dismiss(p.id);
}

function mkProc(over: Partial<Process> = {}): Process {
  const now = Date.now();
  return {
    id: "p1",
    title: "Registry sync",
    body: "writing .claude",
    kind: "local",
    target: null,
    steps: null,
    step: 0,
    progress: 0,
    indeterminate: false,
    status: "running",
    startedAt: now,
    endedAt: null,
    log: [{ ts: now, body: "writing .claude" }],
    retry: null,
    ...over,
  };
}

describe("ProgressBar", () => {
  it("sets a percentage width when determinate", () => {
    const { container } = render(<ProgressBar value={0.42} />);
    const fill = container.querySelector(".lds-progress-fill") as HTMLElement;
    expect(fill.style.width).toBe("42%");
    expect(
      container.querySelector(".lds-progress[data-indeterminate]"),
    ).toBeNull();
  });

  it("marks itself indeterminate when value is null", () => {
    const { container } = render(<ProgressBar value={null} />);
    expect(
      container.querySelector(".lds-progress[data-indeterminate]"),
    ).not.toBeNull();
    const fill = container.querySelector(".lds-progress-fill") as HTMLElement;
    expect(fill.style.width).toBe("");
  });

  it("clamps out-of-range values", () => {
    const { container } = render(<ProgressBar value={2} />);
    const fill = container.querySelector(".lds-progress-fill") as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });
});

describe("LoadingButton", () => {
  it("shows the label + icon and is enabled when not loading", () => {
    render(
      <LoadingButton icon="save" loading={false}>
        Save
      </LoadingButton>,
    );
    const btn = screen.getByRole("button");
    expect(btn).not.toBeDisabled();
    expect(screen.getByText("Save")).toBeInTheDocument();
    expect(btn.querySelector(".lds-spinner")).toBeNull();
  });

  it("swaps in a spinner + loadingLabel and disables while loading", () => {
    render(
      <LoadingButton icon="save" loading loadingLabel="Saving…">
        Save
      </LoadingButton>,
    );
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    expect(btn.className).toContain("is-loading");
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
    expect(btn.querySelector(".lds-spinner")).not.toBeNull();
  });

  it("does not fire onClick while loading", async () => {
    const onClick = vi.fn();
    render(
      <LoadingButton loading onClick={onClick}>
        Save
      </LoadingButton>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("ProcessCard", () => {
  it("renders the title and body", () => {
    render(<ProcessCard proc={mkProc()} />);
    expect(screen.getByText("Registry sync")).toBeInTheDocument();
    expect(screen.getByText("writing .claude")).toBeInTheDocument();
  });

  it("shows a step counter while running with discrete steps", () => {
    render(<ProcessCard proc={mkProc({ steps: 8, step: 3 })} />);
    expect(screen.getByText("3/8")).toBeInTheDocument();
  });

  it("reflects the success status on the card root", () => {
    const { container } = render(
      <ProcessCard proc={mkProc({ status: "success", endedAt: Date.now() })} />,
    );
    expect(container.querySelector(".lds-proc[data-status='success']")).not.toBeNull();
  });

  it("offers Retry on error and invokes the handler", async () => {
    const retry = vi.fn();
    render(
      <ProcessCard
        proc={mkProc({ status: "error", body: "permission denied", retry, endedAt: Date.now() })}
      />,
    );
    expect(screen.getByText("permission denied")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("dismiss button removes the process from the store", async () => {
    resetProcesses();
    const id = Processes.start({ title: "Sync", body: "writing" });
    const proc = Processes.list().find((p) => p.id === id)!;
    render(<ProcessCard proc={proc} />);
    await userEvent.click(screen.getByRole("button", { name: /Hide/ }));
    expect(Processes.list().some((p) => p.id === id)).toBe(false);
  });
});

describe("ProcessCard — log affordance", () => {
  const now = Date.now();

  function failed(over: Partial<Process> = {}): Process {
    return mkProc({
      status: "error",
      startedAt: now,
      endedAt: now,
      body: "Skill registry validation failed: qa-2 frontmatter name mismatch",
      ...over,
    });
  }

  it("offers exactly ONE control for the log, not two", async () => {
    render(
      <ProcessCard
        proc={failed({
          retry: vi.fn(),
          log: [
            { ts: now, body: "writing .claude / .agents" },
            { ts: now, body: "Skill registry validation failed:", source: "cli" },
          ],
        })}
      />,
    );
    // Collapsed: exactly one log control (the disclosure strip). Its count is
    // the COMMAND's lines — the app's own breadcrumb must not inflate it.
    expect(screen.getAllByRole("button", { name: /log/i })).toHaveLength(1);
    const toggle = screen.getByRole("button", { name: /see log · 1 line$/i });

    await userEvent.click(toggle);
    // Expanded: still exactly one — the old "Hide log" twin is gone.
    expect(screen.getAllByRole("button", { name: /log/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Hide log/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /collapse log/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps Retry available without bundling a log link beside it", () => {
    const retry = vi.fn();
    render(<ProcessCard proc={failed({ retry, log: [] })} />);
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /log/i })).toBeNull();
  });

  it("counts command lines only, never the app's own breadcrumb", async () => {
    render(
      <ProcessCard
        proc={failed({
          log: [
            { ts: now, body: "writing .claude / .agents" },
            { ts: now, body: "! advisory", source: "cli" },
            { ts: now, body: "✗ sync completed with danger findings", source: "cli" },
          ],
        })}
      />,
    );
    // 3 rows in the log, but only 2 came from the command.
    expect(
      screen.getByRole("button", { name: /see log · 2 lines$/i }),
    ).toBeInTheDocument();
  });

  it("drops the count entirely when the log is app breadcrumbs only", () => {
    render(
      <ProcessCard
        proc={failed({
          log: [
            { ts: now, body: "writing .claude" },
            { ts: now, body: "writing .agents" },
          ],
        })}
      />,
    );
    // No command output to count — offering "2 lines" would promise the user
    // hub output that isn't there.
    const toggle = screen.getByRole("button", { name: /see log/i });
    expect(toggle.textContent).toContain("see log");
    expect(toggle.textContent).not.toMatch(/\d/);
  });

  it("renders NO log chrome when a failure carries no log lines", () => {
    const { container } = render(<ProcessCard proc={failed({ log: [] })} />);
    expect(container.querySelector(".lds-proc-expander")).toBeNull();
    expect(container.querySelector(".lds-proc-log")).toBeNull();
    // …but the failure itself is still stated on the card face.
    expect(
      screen.getByText(/Skill registry validation failed/),
    ).toBeInTheDocument();
  });

  it("reaches the log on a failure with no retry handler", async () => {
    render(
      <ProcessCard
        proc={failed({
          retry: null,
          log: [{ ts: now, body: "boom", source: "cli" }],
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /see log/i }));
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("stays quiet on a running process whose log is just the seed breadcrumb", () => {
    const { container } = render(
      <ProcessCard proc={mkProc({ log: [{ ts: now, body: "writing" }] })} />,
    );
    expect(container.querySelector(".lds-proc-expander")).toBeNull();
  });

  it("stays quiet on success — a 3.4s banner should not grow chrome", () => {
    const { container } = render(
      <ProcessCard
        proc={mkProc({
          status: "success",
          endedAt: now,
          log: [
            { ts: now, body: "writing" },
            { ts: now, body: "registry aligned" },
          ],
        })}
      />,
    );
    expect(container.querySelector(".lds-proc-expander")).toBeNull();
  });

  it("shows command output without a fabricated per-line elapsed stamp", async () => {
    const { container } = render(
      <ProcessCard
        proc={failed({
          log: [
            { ts: now, body: "writing .claude / .agents" },
            { ts: now, body: "! design-an-interface: missing SKILL.md", source: "cli" },
            { ts: now, body: "Skill registry validation failed:", source: "cli" },
          ],
        })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /see log/i }));

    const lines = container.querySelectorAll(".lds-proc-log-line");
    expect(lines).toHaveLength(3);
    // The app's own breadcrumb keeps its elapsed stamp…
    expect(lines[0].getAttribute("data-source")).toBe("app");
    expect(lines[0].querySelector(".lds-proc-log-ts")?.textContent).toMatch(
      /^\+\d/,
    );
    // …command output does not (we only get it in one buffer at exit).
    expect(lines[1].getAttribute("data-source")).toBe("cli");
    expect(lines[1].querySelector(".lds-proc-log-ts")?.textContent).toBe("");
    expect(
      screen.getByText("! design-an-interface: missing SKILL.md"),
    ).toBeInTheDocument();
  });

  it("exposes the untruncated headline via title for hover", () => {
    const body =
      "Skill registry validation failed: qa-2: frontmatter name is 'qa'; must match registry key";
    const { container } = render(<ProcessCard proc={failed({ body })} />);
    expect(
      container.querySelector(".lds-proc-body")?.getAttribute("title"),
    ).toBe(body);
  });
});

describe("ProcessTray", () => {
  beforeEach(resetProcesses);

  it("renders nothing when there are no processes", () => {
    const { container } = render(<ProcessTray />);
    expect(container.querySelector(".lds-tray")).toBeNull();
  });

  it("renders a card per process", () => {
    Processes.start({ title: "Sync A" });
    Processes.start({ title: "Sync B" });
    const { container } = render(<ProcessTray />);
    expect(container.querySelectorAll(".lds-proc")).toHaveLength(2);
  });

  it("shows the running/done header and clears done cards", async () => {
    vi.useFakeTimers();
    const a = Processes.start({ title: "A" });
    Processes.start({ title: "B" });
    Processes.start({ title: "C" });
    Processes.succeed(a); // a → done; auto-dismiss timer pending but not advanced
    vi.useRealTimers();

    render(<ProcessTray />);
    expect(screen.getByText("2 running · 1 done")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /clear done/ }));
    expect(Processes.list().some((p) => p.id === a)).toBe(false);
    expect(Processes.list()).toHaveLength(2);
  });
});

describe("StatusBarWorking", () => {
  beforeEach(resetProcesses);

  it("renders nothing when no process is running", () => {
    const { container } = render(<StatusBarWorking />);
    expect(container.querySelector(".lds-status-working")).toBeNull();
  });

  it("shows the single-process title and body", () => {
    Processes.start({ title: "Syncing org-skills", body: "git fetch", kind: "remote" });
    render(<StatusBarWorking />);
    expect(screen.getByText("Syncing org-skills")).toBeInTheDocument();
    expect(screen.getByText(/git fetch/)).toBeInTheDocument();
  });

  it("summarises the count when multiple processes run", () => {
    Processes.start({ title: "Syncing one", kind: "remote" });
    Processes.start({ title: "Syncing two", kind: "remote" });
    render(<StatusBarWorking />);
    expect(screen.getByText("2 processes")).toBeInTheDocument();
  });
});

describe("useRunningCount", () => {
  beforeEach(resetProcesses);

  function Counter() {
    const n = useRunningCount();
    return <div data-testid="count">{n}</div>;
  }

  it("counts only running processes", () => {
    vi.useFakeTimers();
    const a = Processes.start({ title: "A" });
    Processes.start({ title: "B" });
    Processes.succeed(a); // terminal — should not count
    vi.useRealTimers();
    render(<Counter />);
    expect(screen.getByTestId("count").textContent).toBe("1");
  });
});
