import { describe, expect, it } from "vitest";
import { bundleSections, changePlaybook } from "@/lib/bundlePlaybook";

describe("bundle playbook membership and order", () => {
  it("recovers loose members from malformed persisted sections", () => {
    expect(bundleSections({ skills: ["a"], playbook: [null, "wrong", { id: "bad", title: "Bad" }] as never })).toEqual([
      { id: "unsectioned", title: "", skills: ["a"] },
    ]);
    expect(bundleSections({ skills: ["a"], playbook: {} as never })[0].skills).toEqual(["a"]);
  });
  it("refuses stale field undo without erasing a newer value", () => {
    const bundle = { skills: [], playbook: [{ id: "work", title: "Work", guidance: "", skills: [] }] };
    const first = changePlaybook(bundle, { kind: "editSection", id: "work", field: "guidance", value: "A" });
    const second = changePlaybook({ ...bundle, playbook: first.sections }, { kind: "editSection", id: "work", field: "guidance", value: "B" });
    expect(() => changePlaybook({ ...bundle, playbook: second.sections }, first.inverse!)).toThrow("Undo the newer edit first");
    const undone = changePlaybook({ ...bundle, playbook: second.sections }, second.inverse!);
    expect(changePlaybook({ ...bundle, playbook: undone.sections }, first.inverse!).sections[0].guidance).toBe("");
  });
  it("retains loose order and appends new members without reviving removed skills", () => {
    expect(bundleSections({ skills: ["a", "b", "c"], playbook: [
      { id: "work", title: "Work", skills: ["removed", "b"] },
      { id: "unsectioned", title: "", skills: ["a", "b"] },
    ] })).toEqual([
      { id: "work", title: "Work", skills: ["b"] },
      { id: "unsectioned", title: "", skills: ["a", "c"] },
    ]);
  });
  it("moves relative to a target without disturbing hidden members and reverses only that move", () => {
    const bundle = { skills: ["a", "b", "c", "d"] };
    const moved = changePlaybook(bundle, { kind: "moveSkill", name: "d", section: "unsectioned", before: "b" });
    expect(moved.sections[0].skills).toEqual(["a", "d", "b", "c"]);
    const later = changePlaybook({ ...bundle, playbook: moved.sections }, { kind: "moveSkill", name: "a", section: "unsectioned" });
    expect(changePlaybook({ ...bundle, playbook: later.sections }, moved.inverse!).sections[0].skills).toEqual(["b", "c", "a", "d"]);
  });
  it("deleting and undoing a section preserves later membership removal", () => {
    const removed = changePlaybook({ skills: ["a", "b"], playbook: [{ id: "work", title: "Work", skills: ["a", "b"] }] }, { kind: "removeSection", id: "work" });
    expect(removed.sections[0].skills).toEqual(["a", "b"]);
    expect(changePlaybook({ skills: ["b"], playbook: removed.sections }, removed.inverse!).sections[0]).toEqual({ id: "work", title: "Work", skills: ["b"] });
  });
});
