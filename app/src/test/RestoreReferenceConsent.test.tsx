import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RestoreConsequences } from "@/components/backup/RestoreConsequences";
import { canApplyRestore, restoreConsentText, toRestorePlan } from "@/lib/restoreContract";

it("discloses unsigned legacy reference placement and gates it on explicit consent", () => {
  const plan = toRestorePlan({
    ok: false, source: "signed-backup", mode: "merge",
    integrity: { ok: true, tree_digest: { ok: true }, trust: { ok: true, hard: false } },
    executable_state: { any: true, requires_consent: true, references_unverified: [{
      rel: "skills/tests/references/criteria.md",
      target_rel: "skills/criteria/SKILL.md",
      sha256: "abc",
    }] },
  });
  expect(plan.executableState).toEqual([]);
  expect(canApplyRestore(plan)).toBe(false);
  expect(canApplyRestore(plan, { executableState: true })).toBe(true);
  expect(restoreConsentText(plan)).toContain("1 unverified reference");
  render(<RestoreConsequences plan={plan} />);
  expect(screen.getByText("skills/tests/references/criteria.md")).toBeInTheDocument();
  expect(screen.getByText("Content from skills/criteria/SKILL.md")).toBeInTheDocument();
  expect(screen.getByText(/Reference placements not covered by the signature/)).toBeInTheDocument();
  expect(screen.queryByText(/Executable state being installed/)).toBeNull();
});
