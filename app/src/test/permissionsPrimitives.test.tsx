import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { RiskBadge } from "@/components/RiskBadge";
import { CapabilityPlaceholder } from "@/components/CapabilityPlaceholder";
import { HarnessAffinityChips } from "@/components/HarnessAffinityChips";
import { PermissionRow } from "@/components/PermissionRow";
import { AdoptionDialog } from "@/components/AdoptionDialog";
import { DisableDialog } from "@/components/DisableDialog";
import { PermissionsDoctorPanel } from "@/components/PermissionsDoctorPanel";

import type { Capabilities, DisableResult, Rule } from "@/types/permissions";

const CAPS: Capabilities = {
	"claude-code": [
		"tool_allowlist",
		"tool_denylist",
		"tool_ask",
		"hooks",
		"additional_directories",
	],
	codex: ["sandbox_mode", "approval_policy", "project_trust"],
	pi: [
		"tool_allowlist",
		"tool_denylist",
		"tool_ask",
		"hooks",
		"additional_directories",
	],
};

describe("RiskBadge", () => {
	it("renders the code in mono with danger color", () => {
		render(
			<RiskBadge code="UNBOUNDED_BASH" severity="danger" explanation="Bad." />,
		);
		const badge = screen.getByText("UNBOUNDED_BASH");
		expect(badge.closest("span")?.style.fontFamily).toBe("var(--font-mono)");
	});

	it("uses amber for warning severity", () => {
		render(<RiskBadge code="X" severity="warning" explanation="meh" />);
		expect(screen.getByText("X")).toBeInTheDocument();
	});
});

describe("CapabilityPlaceholder", () => {
	it("lists unsupported harness labels with cyan accent", () => {
		render(
			<CapabilityPlaceholder unsupportedLabels={["Codex"]} feature="hooks" />,
		);
		expect(screen.getByText(/Not supported by/)).toBeInTheDocument();
		expect(screen.getByText("Codex")).toBeInTheDocument();
		expect(screen.getByText(/hooks unavailable/)).toBeInTheDocument();
	});
});

describe("HarnessAffinityChips", () => {
	it("collapses to a single 'all' pill when affinity is null and every chip would be applied", () => {
		render(
			<HarnessAffinityChips
				installedHarnesses={["claude-code", "pi"]}
				capabilities={CAPS}
				feature="tool_allowlist"
				affinity={null}
			/>,
		);
		expect(screen.getByText("all")).toBeInTheDocument();
	});

	it("expands and shows applied/unsupported/excluded states", () => {
		render(
			<HarnessAffinityChips
				installedHarnesses={["claude-code", "codex", "pi"]}
				capabilities={CAPS}
				feature="tool_allowlist"
				affinity={["claude-code"]}
			/>,
		);
		// claude-code: applied, codex: unsupported (no tool_allowlist), pi: excluded
		const cc = screen.getByRole("button", { name: /CC/ });
		const cx = screen.getByRole("button", { name: /CX/ });
		const pi = screen.getByRole("button", { name: /PI/ });
		expect(cc).toHaveAttribute("data-state", "applied");
		expect(cx).toHaveAttribute("data-state", "unsupported");
		expect(pi).toHaveAttribute("data-state", "excluded");
		expect(cx).toBeDisabled(); // unsupported is read-only
	});

	it("invokes onToggle when an applied chip is clicked", () => {
		const fn = vi.fn();
		render(
			<HarnessAffinityChips
				installedHarnesses={["claude-code", "pi"]}
				capabilities={CAPS}
				feature="tool_allowlist"
				affinity={["claude-code", "pi"]}
				onToggle={fn}
				collapsedWhenAll={false}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /CC/ }));
		expect(fn).toHaveBeenCalledWith("claude-code", "excluded");
	});
});

describe("PermissionRow", () => {
	const rule: Rule = {
		pattern: "Bash(npm:*)",
		kind: "allow",
		origin: "project",
	};

	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("renders kind badge, mono pattern, and project provenance", () => {
		render(
			<PermissionRow
				rule={rule}
				scopeKind="project"
				installedHarnesses={["claude-code"]}
				capabilities={CAPS}
			/>,
		);
		expect(screen.getByText("ALLOW")).toBeInTheDocument();
		const input = screen.getByLabelText("Pattern") as HTMLInputElement;
		expect(input.value).toBe("Bash(npm:*)");
		expect(screen.getByText("project")).toBeInTheDocument();
	});

	it("shows Copy-to-project affordance and is read-only when origin=global in a project", () => {
		const onPromote = vi.fn();
		render(
			<PermissionRow
				rule={{ ...rule, origin: "global" }}
				scopeKind="project"
				installedHarnesses={["claude-code"]}
				capabilities={CAPS}
				onPromote={onPromote}
			/>,
		);
		expect(screen.getByLabelText("Pattern")).toBeDisabled();
		const promote = screen.getByRole("button", { name: /Copy to project/ });
		expect(promote.getAttribute("title")).toMatch(
			/global rule stays in effect/i,
		);
		fireEvent.click(promote);
		expect(onPromote).toHaveBeenCalled();
	});

	it("renders an inline risk badge when risks attach to the row", () => {
		render(
			<PermissionRow
				rule={{ ...rule, pattern: "Bash(*)" }}
				scopeKind="project"
				installedHarnesses={["claude-code"]}
				capabilities={CAPS}
				risks={[
					{
						code: "UNBOUNDED_BASH",
						severity: "danger",
						explanation: "no good",
						detail: "Bash(*)",
					},
				]}
			/>,
		);
		expect(screen.getByText("UNBOUNDED_BASH")).toBeInTheDocument();
	});

	it("calls onDelete when the trash button is clicked", () => {
		const onDelete = vi.fn();
		render(
			<PermissionRow
				rule={rule}
				scopeKind="project"
				installedHarnesses={["claude-code"]}
				capabilities={CAPS}
				onDelete={onDelete}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Delete rule" }));
		expect(onDelete).toHaveBeenCalled();
	});

	it("does not flag Codex unsupported for a Bash rule, but does for a non-Bash rule", () => {
		// Codex now advertises Bash-scoped command-rule support.
		const codexCaps: Capabilities = {
			codex: ["tool_allowlist", "tool_denylist", "tool_ask"],
		};
		const { unmount } = render(
			<PermissionRow
				rule={{ pattern: "Bash(npm:*)", kind: "allow", origin: "project" }}
				scopeKind="project"
				installedHarnesses={["codex"]}
				capabilities={codexCaps}
			/>,
		);
		expect(screen.getByRole("button", { name: /CX/ })).toHaveAttribute(
			"data-state",
			"applied",
		);
		unmount();

		// A non-Bash pattern is still unsupported for Codex (D6 Bash-only caveat).
		render(
			<PermissionRow
				rule={{ pattern: "Read(*)", kind: "allow", origin: "project" }}
				scopeKind="project"
				installedHarnesses={["codex"]}
				capabilities={codexCaps}
			/>,
		);
		expect(screen.getByRole("button", { name: /CX/ })).toHaveAttribute(
			"data-state",
			"unsupported",
		);
	});
});

describe("AdoptionDialog", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("renders discovered rules and dispatches the chosen action", async () => {
		vi.mocked(invoke).mockResolvedValue({
			scope_kind: "global",
			harness_id: "claude-code",
			action: "import",
			imported: 3,
			backup_path: "/tmp/backup",
			unmanaged_after: [],
		});
		const onResolved = vi.fn();
		render(
			<AdoptionDialog
				open
				discovered={{
					"claude-code": [
						{
							pattern: "Bash(npm:*)",
							kind: "allow",
							source_file: "/Users/me/.claude/settings.json",
						},
					],
				}}
				onResolved={onResolved}
				harnessLabels={{ "claude-code": "Claude Code" }}
			/>,
		);
		expect(screen.getByText("Bash(npm:*)")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Import/ }));
		await Promise.resolve();
		await Promise.resolve();
		expect(invoke).toHaveBeenCalledWith(
			"permissions_adopt",
			expect.objectContaining({ action: "import", harness: "claude-code" }),
		);
	});
});

describe("DisableDialog", () => {
	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it("renders the dry-run preview from structured entries", async () => {
		const preview: DisableResult = {
			mode: "restore",
			apply: false,
			entries: [
				{
					scope_kind: "global",
					scope_label: "global",
					harness_id: "claude-code",
					target_file: "/.claude/settings.json",
					backup_path: "/_hub-backups/permissions/claude-code/global/123.json",
					sidecar_path: "/state/claude-code/global.managed.json",
					action: "restore",
					will_write: true,
				},
			],
		};
		vi.mocked(invoke).mockResolvedValue(preview);
		render(
			<DisableDialog
				open
				fromScope={{ kind: "global" }}
				projectCount={3}
				onClose={() => {}}
				onApplied={() => {}}
			/>,
		);
		// dry-run is async; wait a tick
		await new Promise((r) => setTimeout(r, 10));
		expect(screen.getByText("/.claude/settings.json")).toBeInTheDocument();
	});

	it("requires the strict checkbox when target = Everything", async () => {
		vi.mocked(invoke).mockResolvedValue({
			mode: "restore",
			apply: false,
			entries: [],
		});
		render(
			<DisableDialog
				open
				fromScope={{ kind: "global" }}
				projectCount={2}
				onClose={() => {}}
				onApplied={() => {}}
			/>,
		);
		fireEvent.click(screen.getByLabelText(/Everything \(incl\. global\)/));
		expect(
			screen.getByText(
				/I understand this affects every project and the global scope/,
			),
		).toBeInTheDocument();
	});

	it("requires the softer checkbox when target = All projects", async () => {
		vi.mocked(invoke).mockResolvedValue({
			mode: "restore",
			apply: false,
			entries: [],
		});
		render(
			<DisableDialog
				open
				fromScope={{ kind: "global" }}
				projectCount={4}
				onClose={() => {}}
				onApplied={() => {}}
			/>,
		);
		fireEvent.click(screen.getByLabelText(/All projects/));
		expect(
			screen.getByText(/I understand this affects all 4 projects/),
		).toBeInTheDocument();
	});
});

describe("PermissionsDoctorPanel", () => {
	it("groups repeated findings and fires click-through callback", () => {
		const onJump = vi.fn();
		render(
			<PermissionsDoctorPanel
				open
				findings={[
					{
						code: "UNBOUNDED_BASH",
						severity: "danger",
						explanation: "scary",
						detail: "Bash(*)",
						scope_kind: "project",
						scope_label: "alpha",
						harness_id: "pi",
					},
					{
						code: "UNBOUNDED_BASH",
						severity: "danger",
						explanation: "scary",
						detail: "Bash(*)",
						scope_kind: "global",
						scope_label: "global",
						harness_id: "claude-code",
					},
				]}
				onClose={() => {}}
				onJumpToFinding={onJump}
			/>,
		);
		expect(screen.getByText("scary")).toBeInTheDocument();
		expect(screen.getByText("2 hits")).toBeInTheDocument();
		expect(screen.getByText(/global \+ project:alpha/)).toBeInTheDocument();
		fireEvent.click(screen.getByText("scary"));
		expect(onJump).toHaveBeenCalled();
	});

	it("copies the full diagnostics JSON", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });
		render(
			<PermissionsDoctorPanel
				open
				findings={[
					{
						code: "UNBOUNDED_BASH",
						severity: "danger",
						explanation: "scary",
						detail: "Bash(*)",
						scope_kind: "project",
						scope_label: "alpha",
					},
				]}
				onClose={() => {}}
			/>,
		);
		fireEvent.click(screen.getByText("Copy full JSON"));
		await waitFor(() => expect(writeText).toHaveBeenCalled());
		expect(writeText.mock.calls[0][0]).toContain('"danger_count": 1');
	});

	it("shows the all-clear message when no findings", () => {
		render(<PermissionsDoctorPanel open findings={[]} onClose={() => {}} />);
		expect(screen.getByText(/All checks pass/)).toBeInTheDocument();
	});
});
