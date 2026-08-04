import { describe, it, expect, beforeEach, vi } from "vitest";
import { Processes } from "@/store/processes";
import { trackProcess } from "@/lib/trackProcess";

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
    } finally {
      vi.useRealTimers();
    }
  });
});
