import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Spinner } from "@/components/loading/Spinner";
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

describe("Spinner", () => {
  it("renders the ring and applies size + stroke", () => {
    const { container } = render(<Spinner size={20} stroke={3} />);
    const el = container.querySelector(".lds-spinner") as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.style.width).toBe("20px");
    expect(el.style.borderWidth).toBe("3px");
  });
});

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
