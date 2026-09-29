import { describe, it, expect } from "vitest";
import {
	REACH_AFFINITY_TEXT,
	harnessReachHint,
	reachBadges,
	reachRollup,
} from "@/lib/hookReach";
import type { HookCapabilitiesCache } from "@/hooks/useHooks";

// AUDIT M4: `reachRollup` / `harnessReachHint` shipped with zero tests. Both
// carry a written invariant ("the head summary and the body can never
// disagree", "the same three sentences `HarnessReachPanel` renders") — this
// file is what actually holds them to it.

function caps(
	entries: Record<string, { verdict: string; reason?: string }>,
): HookCapabilitiesCache {
	const harnesses: HookCapabilitiesCache["harnesses"] = {};
	for (const [id, e] of Object.entries(entries)) {
		harnesses[id] = {
			harness_id: id,
			verdict: e.verdict as never,
			reason: e.reason ?? "",
			extra: {},
		};
	}
	return { schema_version: 1, probed_at: "2026-01-01T00:00:00Z", harnesses };
}

describe("reachBadges", () => {
	it("marks a supported harness ok", () => {
		const badges = reachBadges(caps({ "claude-code": { verdict: "supported" } }));
		expect(badges).toEqual([
			{
				harnessId: "claude-code",
				verdict: "supported",
				tone: "ok",
				eventUnsupported: false,
				reason: "",
			},
		]);
	});

	it("marks feature_off and unsupported neutral, both reachable-shaped or not", () => {
		const badges = reachBadges(
			caps({
				codex: { verdict: "feature_off", reason: "hooks disabled in config" },
				opencode: { verdict: "unsupported", reason: "no hook adapter" },
			}),
		);
		expect(badges.find((b) => b.harnessId === "codex")).toMatchObject({
			verdict: "feature_off",
			tone: "neutral",
		});
		expect(badges.find((b) => b.harnessId === "opencode")).toMatchObject({
			verdict: "unsupported",
			tone: "neutral",
		});
	});

	it("omits not_installed entirely (showing it is noise)", () => {
		const badges = reachBadges(caps({ pi: { verdict: "not_installed" } }));
		expect(badges).toEqual([]);
	});

	it("downgrades an otherwise-reachable harness the SELECTED event doesn't support", () => {
		const badges = reachBadges(
			caps({ codex: { verdict: "supported" } }),
			"Notification", // codex's 10-event subset excludes this
		);
		expect(badges[0]).toMatchObject({
			verdict: "supported",
			tone: "neutral",
			eventUnsupported: true,
		});
	});

	it("returns [] when the probe has never run (caps null)", () => {
		expect(reachBadges(null)).toEqual([]);
		expect(reachBadges(undefined)).toEqual([]);
	});
});

describe("reachRollup", () => {
	it("caps-null: admits ignorance instead of asserting 'fires on 0 of N' (AUDIT M3)", () => {
		const r = reachRollup(["claude-code", "codex"], [], null, "PostToolUse");
		expect(r.capsKnown).toBe(false);
		expect(r.total).toBe(2);
		// fires is meaningless while capsKnown is false — callers must gate on
		// capsKnown, never read fires/total as a definite verdict.
	});

	it("unrestricted: every installed, reachable harness counts", () => {
		const c = caps({
			"claude-code": { verdict: "supported" },
			codex: { verdict: "supported" },
		});
		const r = reachRollup(["claude-code", "codex"], [], c, "PostToolUse");
		expect(r).toEqual({ fires: 2, total: 2, capsKnown: true });
	});

	it("narrowed: an excluded harness never counts even if it would otherwise fire", () => {
		const c = caps({
			"claude-code": { verdict: "supported" },
			codex: { verdict: "supported" },
		});
		const r = reachRollup(["claude-code", "codex"], ["claude-code"], c, "PostToolUse");
		expect(r).toEqual({ fires: 1, total: 2, capsKnown: true });
	});

	it("event-downgraded: a targeted harness that doesn't support the event doesn't count", () => {
		const c = caps({
			"claude-code": { verdict: "supported" },
			codex: { verdict: "supported" },
		});
		const r = reachRollup(["claude-code", "codex"], [], c, "Notification");
		expect(r).toEqual({ fires: 1, total: 2, capsKnown: true });
	});

	it("not-installed-but-targeted: still a row, never counted as firing", () => {
		const c = caps({ "claude-code": { verdict: "supported" } });
		// codex is in the affinity (part of the definition) but not installed —
		// HarnessReachPanel still gives it a row; reachBadges has no entry for
		// it at all, so it can never contribute a `fires`.
		const r = reachRollup(["claude-code"], ["claude-code", "codex"], c, "PostToolUse");
		expect(r).toEqual({ fires: 1, total: 2, capsKnown: true });
	});

	it("sole-harness: one installed, one row, counts if supported", () => {
		const c = caps({ "claude-code": { verdict: "supported" } });
		const r = reachRollup(["claude-code"], [], c, "PostToolUse");
		expect(r).toEqual({ fires: 1, total: 1, capsKnown: true });
	});
});

describe("harnessReachHint", () => {
	// Read from the SAME shared const `HarnessReachPanel` renders from (AUDIT
	// M4) — a literal-string duplicate here could drift from the body text
	// without either test noticing.
	it("sole harness", () => {
		expect(harnessReachHint(["claude-code"], [])).toBe(
			REACH_AFFINITY_TEXT.soleHarness("Claude Code"),
		);
	});

	it("unrestricted (multiple installed, no affinity)", () => {
		expect(harnessReachHint(["claude-code", "codex"], [])).toBe(
			REACH_AFFINITY_TEXT.unrestricted,
		);
	});

	it("narrowed (affinity excludes at least one installed harness)", () => {
		expect(harnessReachHint(["claude-code", "codex"], ["claude-code"])).toBe(
			REACH_AFFINITY_TEXT.narrowed,
		);
	});
});
