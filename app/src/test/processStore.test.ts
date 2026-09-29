import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Processes, useRunningTargets } from "@/store/processes";
import { trackProcess } from "@/lib/trackProcess";
import { HubCommandError } from "@/lib/hubCmd";

/** The store is a module singleton; clear it before each test. */
function resetProcesses() {
  for (const p of Processes.list()) Processes.dismiss(p.id);
}

describe("Processes registry", () => {
  beforeEach(resetProcesses);

  it("start() inserts a running card with progress 0 and seeds the log", () => {
    const id = Processes.start({ title: "Sync", body: "writing", kind: "local" });
    const p = Processes.list().find((x) => x.id === id)!;
    expect(p).toBeDefined();
    expect(p.status).toBe("running");
    expect(p.progress).toBe(0);
    expect(p.kind).toBe("local");
    expect(p.log).toEqual([expect.objectContaining({ body: "writing" })]);
  });

  it("indeterminate start has null progress and an empty log when bodyless", () => {
    const id = Processes.start({ title: "X", indeterminate: true });
    const p = Processes.list().find((x) => x.id === id)!;
    expect(p.progress).toBeNull();
    expect(p.indeterminate).toBe(true);
    expect(p.log).toEqual([]);
  });

  it("issues unique, stable ids", () => {
    const a = Processes.start({ title: "A" });
    const b = Processes.start({ title: "B" });
    expect(a).not.toBe(b);
  });

  it("update() patches fields and appends a log line when the body changes", () => {
    const id = Processes.start({ title: "X", body: "a", kind: "remote" });
    Processes.update(id, { progress: 0.5, body: "b" });
    const p = Processes.list().find((x) => x.id === id)!;
    expect(p.progress).toBe(0.5);
    expect(p.body).toBe("b");
    expect(p.log.map((l) => l.body)).toEqual(["a", "b"]);
  });

  it("update() does not append to the log when the body is unchanged", () => {
    const id = Processes.start({ title: "X", body: "a" });
    Processes.update(id, { progress: 0.3 });
    const p = Processes.list().find((x) => x.id === id)!;
    expect(p.log).toHaveLength(1);
  });

  it("caps the log at 12 entries", () => {
    const id = Processes.start({ title: "X", body: "b0" });
    for (let i = 1; i <= 20; i++) Processes.update(id, { body: `b${i}` });
    const p = Processes.list().find((x) => x.id === id)!;
    expect(p.log).toHaveLength(12);
    // Keeps the most recent entries.
    expect(p.log[p.log.length - 1].body).toBe("b20");
  });

  it("succeed() flips to success, fills progress, and auto-dismisses after 3.4s", () => {
    vi.useFakeTimers();
    try {
      const id = Processes.start({ title: "X" });
      Processes.succeed(id, "done");
      const p = Processes.list().find((x) => x.id === id)!;
      expect(p.status).toBe("success");
      expect(p.progress).toBe(1);
      expect(p.body).toBe("done");
      expect(p.endedAt).not.toBeNull();

      vi.advanceTimersByTime(3399);
      expect(Processes.list().some((x) => x.id === id)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(Processes.list().some((x) => x.id === id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fail() flips to error, keeps the retry handle, and never auto-dismisses", () => {
    vi.useFakeTimers();
    try {
      const retry = vi.fn();
      const id = Processes.start({ title: "X" });
      Processes.fail(id, "boom", { retry });
      const p = Processes.list().find((x) => x.id === id)!;
      expect(p.status).toBe("error");
      expect(p.body).toBe("boom");
      expect(p.retry).toBe(retry);

      vi.advanceTimersByTime(60_000);
      expect(Processes.list().some((x) => x.id === id)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismiss() removes a single process", () => {
    const id = Processes.start({ title: "X" });
    Processes.dismiss(id);
    expect(Processes.list().some((x) => x.id === id)).toBe(false);
  });

  it("dismissAllDone() clears terminal cards but keeps running ones", () => {
    vi.useFakeTimers();
    try {
      const a = Processes.start({ title: "A" });
      const b = Processes.start({ title: "B" });
      Processes.succeed(a);
      Processes.dismissAllDone();
      const ids = Processes.list().map((p) => p.id);
      expect(ids).toContain(b);
      expect(ids).not.toContain(a);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Processes.fail", () => {
  beforeEach(resetProcesses);

  it("is idempotent — a second fail neither duplicates the log nor re-stamps", () => {
    const id = Processes.start({ title: "Sync", body: "writing" });
    Processes.fail(id, "boom", { log: ["line a", "line b"] });
    const endedAt = Processes.list().find((p) => p.id === id)!.endedAt;

    Processes.fail(id, "boom again", { log: ["line a", "line b"] });
    const p = Processes.list().find((p) => p.id === id)!;

    expect(p.log).toHaveLength(3); // breadcrumb + 2, not 5
    expect(p.body).toBe("boom");
    expect(p.endedAt).toBe(endedAt);
  });

  it("drops blank output lines", () => {
    const id = Processes.start({ title: "X" });
    Processes.fail(id, "boom", { log: ["real", "   ", "", "also real"] });
    expect(Processes.list()[0].log.map((l) => l.body)).toEqual([
      "real",
      "also real",
    ]);
  });

  it("caps huge output from the TAIL and never evicts app breadcrumbs", () => {
    const id = Processes.start({ title: "Sync", body: "writing .claude" });
    Processes.update(id, { body: "writing .agents" }); // a 2nd app breadcrumb
    const flood = Array.from({ length: 500 }, (_, i) => `out ${i}`);
    Processes.fail(id, "boom", { log: flood });

    const p = Processes.list()[0];
    const app = p.log.filter((l) => l.source !== "cli");
    const cli = p.log.filter((l) => l.source === "cli");

    // Both breadcrumbs survive — a blanket slice over the MERGED list would
    // have deleted them, and the e2e counts data-source="app" rows.
    expect(app.map((l) => l.body)).toEqual([
      "writing .claude",
      "writing .agents",
    ]);
    // 200 kept + 1 elision notice, and the TAIL is what was kept (a CLI's
    // failure lives at the end of its narration).
    expect(cli).toHaveLength(201);
    expect(cli[0].body).toBe("… 300 earlier lines omitted");
    expect(cli[cli.length - 1].body).toBe("out 499");
    expect(cli.some((l) => l.body === "out 299")).toBe(false);
    expect(cli.some((l) => l.body === "out 300")).toBe(true);
  });

  it("says 'line' not 'lines' when exactly one was dropped", () => {
    const id = Processes.start({ title: "X" });
    Processes.fail(id, "boom", {
      log: Array.from({ length: 201 }, (_, i) => `out ${i}`),
    });
    expect(Processes.list()[0].log[0].body).toBe("… 1 earlier line omitted");
  });
});

describe("useRunningTargets", () => {
  beforeEach(resetProcesses);

  it("returns only RUNNING targets that start with the prefix", () => {
    const matching = Processes.start({ title: "A", target: "bundle-add:android:one" });
    Processes.start({ title: "B", target: "bundle-add:other:two" }); // wrong prefix
    const settled = Processes.start({ title: "C", target: "bundle-add:android:three" });
    Processes.succeed(settled); // matches the prefix, but no longer running

    const { result } = renderHook(() => useRunningTargets("bundle-add:android:"));
    expect(result.current).toEqual(["bundle-add:android:one"]);
    expect(Processes.list().find((p) => p.id === matching)?.status).toBe("running");
  });

  it("drops a target once its process is no longer running", () => {
    const id = Processes.start({ title: "A", target: "bundle-add:android:one" });
    const { result, rerender } = renderHook(() => useRunningTargets("bundle-add:android:"));
    expect(result.current).toEqual(["bundle-add:android:one"]);

    act(() => Processes.succeed(id));
    rerender();
    expect(result.current).toEqual([]);
  });

  it("returns an empty array for a null prefix even with running processes", () => {
    Processes.start({ title: "A", target: "bundle-add:android:one" });
    const { result } = renderHook(() => useRunningTargets(null));
    expect(result.current).toEqual([]);
  });

  it("keeps the SAME array reference across a store update that changes nothing under the prefix", () => {
    Processes.start({ title: "A", target: "bundle-add:android:one" });
    const other = Processes.start({ title: "B", target: "bundle-add:other:two" });

    const { result, rerender } = renderHook(() => useRunningTargets("bundle-add:android:"));
    const first = result.current;

    // An update to a process OUTSIDE the prefix (e.g. per-chunk progress on
    // an unrelated write elsewhere) must not hand the row a fresh array —
    // that would defeat the whole point of narrowing off `useProcesses()`.
    act(() => Processes.update(other, { body: "chunk 2/9" }));
    rerender();

    expect(result.current).toBe(first);
  });
});

describe("trackProcess", () => {
  beforeEach(resetProcesses);

  it("starts a running process and succeeds with the result, returning it", async () => {
    vi.useFakeTimers();
    try {
      const promise = trackProcess(
        { title: "Save", kind: "fs" },
        async () => "ok",
        { successBody: "saved" },
      );
      // The card exists and is running before the operation settles.
      expect(Processes.list().some((p) => p.status === "running")).toBe(true);

      const result = await promise;
      expect(result).toBe("ok");

      const p = Processes.list()[0];
      expect(p.status).toBe("success");
      expect(p.body).toBe("saved");
      expect(p.kind).toBe("fs");
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to an indeterminate card", async () => {
    vi.useFakeTimers();
    try {
      const promise = trackProcess({ title: "X" }, async () => undefined);
      expect(Processes.list()[0].indeterminate).toBe(true);
      await promise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports a successBody derived from the result", async () => {
    vi.useFakeTimers();
    try {
      const r = await trackProcess({ title: "X" }, async () => 42, {
        successBody: (n) => `got ${n}`,
      });
      expect(r).toBe(42);
      expect(Processes.list()[0].body).toBe("got 42");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the process and rethrows on error, wiring the retry handle", async () => {
    vi.useFakeTimers();
    try {
      const retry = vi.fn();
      const err = new Error("nope");
      await expect(
        trackProcess({ title: "X" }, async () => Promise.reject(err), { retry }),
      ).rejects.toBe(err);

      const p = Processes.list()[0];
      expect(p.status).toBe("error");
      expect(p.body).toBe("nope");
      expect(p.retry).toBe(retry);
      // A plain Error carries no command output — nothing to log, so the card
      // keeps only its seeded breadcrumb and renders no log chrome.
      expect(p.log.filter((l) => l.source === "cli")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits a hub failure into a headline body and the full output log", async () => {
    vi.useFakeTimers();
    try {
      const E = String.fromCharCode(27);
      const stdout = `${E}[33m!${E}[0m legacy-notes: missing SKILL.md\n`;
      const stderr = [
        `${E}[1m${E}[31mSkill registry validation failed:${E}[0m`,
        "  - qa-2: frontmatter name is 'qa'; must match registry key",
        "",
      ].join("\n");
      const err = new HubCommandError(
        { success: false, output: stdout + stderr, stdout, stderr },
        ["sync"],
      );

      await expect(
        trackProcess(
          { title: "Registry sync", body: "writing .claude / .agents" },
          async () => Promise.reject(err),
        ),
      ).rejects.toBe(err);

      const p = Processes.list()[0];
      // Body = the real stderr error, not the leading stdout warning.
      expect(p.body).toBe(
        "Skill registry validation failed: qa-2: frontmatter name is 'qa'; must match registry key",
      );
      expect(p.body).not.toContain(E);
      // Log = the client breadcrumb PLUS every line the command printed.
      expect(p.log.map((l) => l.body)).toEqual([
        "writing .claude / .agents",
        "! legacy-notes: missing SKILL.md",
        "Skill registry validation failed:",
        "  - qa-2: frontmatter name is 'qa'; must match registry key",
      ]);
      expect(p.log.map((l) => l.source)).toEqual([
        undefined,
        "cli",
        "cli",
        "cli",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
