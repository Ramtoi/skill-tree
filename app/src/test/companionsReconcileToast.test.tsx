// Wave 2 (Approach 9/10, W12, wave C): the I7 reconcile result rendered as a
// toast. `reconcileToastInfo` is pure (title/body/provisionProject);
// `pushReconcileToast` wires the `Provision` action through the SAME gate
// every other `Provision` affordance uses (A22/C1: no `force`), and re-toasts
// instead of throwing when another consequence dialog is already open.

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	pushReconcileToast,
	reconcileToastInfo,
} from "@/components/companions/CompanionsEditSheet";
import { equipWithGate } from "@/hooks/useCompanionGate";
import type { ReconcileResult } from "@/lib/companions";

vi.mock("@/hooks/useCompanionGate", () => ({
	equipWithGate: vi.fn(),
}));

function fakeToast() {
	return {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		push: vi.fn(),
	};
}

describe("reconcileToastInfo", () => {
	it("names one project's pending count", () => {
		const result: ReconcileResult = {
			projects: {
				"notes-vault": {
					pending: ["orch-unit-brief"],
					stale_removed: [],
					reattached: [],
					drift: [],
					missing_refs: [],
				},
			},
		};
		const info = reconcileToastInfo(result);
		expect(info.title).toBe("1 pending on notes-vault");
		expect(info.provisionProject).toBe("notes-vault");
	});

	it("says 'pending on N projects' once more than one carries a pending companion", () => {
		const result: ReconcileResult = {
			projects: {
				"notes-vault": {
					pending: ["orch-unit-brief"],
					stale_removed: [],
					reattached: [],
					drift: [],
					missing_refs: [],
				},
				"moon-base": {
					pending: ["orch-unit-brief"],
					stale_removed: [],
					reattached: [],
					drift: [],
					missing_refs: [],
				},
			},
		};
		const info = reconcileToastInfo(result);
		expect(info.title).toBe("pending on 2 projects");
		// The action still has to go SOMEWHERE — the first project alphabetically
		// by insertion order is as good a default as any; the toast body is what
		// actually names every removal.
		expect(info.provisionProject).not.toBeNull();
	});

	it("names every removed companion in the body", () => {
		const result: ReconcileResult = {
			projects: {
				"notes-vault": {
					pending: [],
					stale_removed: ["orch-unit-brief", "orch-report-guard"],
					reattached: [],
					drift: [],
					missing_refs: [],
				},
			},
		};
		const info = reconcileToastInfo(result);
		expect(info.body).toContain("orch-unit-brief");
		expect(info.body).toContain("orch-report-guard");
		expect(info.provisionProject).toBeNull();
	});

	it("reads as reconciled with nothing to report", () => {
		const result: ReconcileResult = { projects: {} };
		const info = reconcileToastInfo(result);
		expect(info.title).toBe("Reconciled");
		expect(info.body).toBeUndefined();
		expect(info.provisionProject).toBeNull();
	});
});

describe("pushReconcileToast", () => {
	beforeEach(() => {
		vi.mocked(equipWithGate).mockReset();
	});

	const PENDING: ReconcileResult = {
		projects: {
			"notes-vault": {
				pending: ["orch-unit-brief"],
				stale_removed: [],
				reattached: [],
				drift: [],
				missing_refs: [],
			},
		},
	};

	it("pushes a toast whose action calls equipWithGate with NO force", async () => {
		vi.mocked(equipWithGate).mockResolvedValue(undefined);
		const toast = fakeToast();
		pushReconcileToast(toast, "orchestrate-advanced", PENDING);

		expect(toast.push).toHaveBeenCalledTimes(1);
		const pushed = toast.push.mock.calls[0][0];
		expect(pushed.title).toBe("1 pending on notes-vault");
		expect(pushed.action?.label).toBe("Provision");

		pushed.action.onClick();
		await vi.waitFor(() => expect(equipWithGate).toHaveBeenCalled());
		expect(equipWithGate).toHaveBeenCalledWith("orchestrate-advanced", "notes-vault");
		// Exactly two args — never a third `force`/opts argument.
		expect(vi.mocked(equipWithGate).mock.calls[0]).toHaveLength(2);
	});

	it("carries no action when nothing is pending", () => {
		const toast = fakeToast();
		pushReconcileToast(toast, "orchestrate-advanced", { projects: {} });
		const pushed = toast.push.mock.calls[0][0];
		expect(pushed.action).toBeUndefined();
	});

	it("re-toasts instead of throwing when another gate is already open (C1)", async () => {
		vi.mocked(equipWithGate).mockRejectedValue(
			new Error("Another equip consequence dialog is already open."),
		);
		const toast = fakeToast();
		pushReconcileToast(toast, "orchestrate-advanced", PENDING);
		const pushed = toast.push.mock.calls[0][0];

		pushed.action.onClick();
		await vi.waitFor(() =>
			expect(toast.info).toHaveBeenCalledWith("Another equip is open — finish it first."),
		);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("reports a real provision failure as an error toast", async () => {
		vi.mocked(equipWithGate).mockRejectedValue(new Error("disk full"));
		const toast = fakeToast();
		pushReconcileToast(toast, "orchestrate-advanced", PENDING);
		const pushed = toast.push.mock.calls[0][0];

		pushed.action.onClick();
		await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(toast.error.mock.calls[0][0]).toBe("Couldn't provision companions");
		expect(toast.error.mock.calls[0][1]).toBe("disk full");
	});
});
