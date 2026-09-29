import { expect, it } from "vitest";
import type { SkillRefsGraph } from "@/types";
import { skillReferenceStats } from "@/lib/skillRowStats";

it("keeps unavailable graph data distinct from known zero relationships", () => {
  expect(skillReferenceStats(undefined)).toBeUndefined();
  expect(skillReferenceStats({} as SkillRefsGraph)).toBeUndefined();
  expect(skillReferenceStats({ edges: [] })).toEqual(new Map());
});

it("counts distinct related skills, not mention frequency, duplicate edges or self links", () => {
  const result = skillReferenceStats({ edges: [
    { from: "a", to: "b", count: 9 }, { from: "a", to: "b", count: 2 },
    { from: "c", to: "a", count: 1 }, { from: "a", to: "a", count: 5 },
  ] });
  expect(result?.get("a")).toEqual({ outgoing: ["b"], incoming: ["c"] });
  expect(result?.get("b")).toEqual({ outgoing: [], incoming: ["a"] });
});
