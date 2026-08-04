import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { DriftBadge } from "@/components/remotes/DriftBadge";
import { RiskBadge } from "@/components/RiskBadge";
import { SnippetStatusBadge } from "@/components/snippets/SnippetStatusBadge";
import { StatePill } from "@/components/StatePill";
import { ConfirmDialog, Modal, Sheet } from "@/components/Modal";
import { Toggle } from "@/components/Toggle";
import { SkillCard } from "@/components/SkillCard";
import { PermissionsDoctorPanel } from "@/components/PermissionsDoctorPanel";

// ─── A4: every status badge is a StatusBadge preset (channel, never violet) ──
describe("StatusBadge preset adoption", () => {
	it("DriftBadge renders through StatusBadge with a status channel", () => {
		const { container } = render(<DriftBadge status="conflict" />);
		const badge = container.querySelector(".status-badge");
		expect(badge).toBeTruthy();
		expect(badge?.getAttribute("data-channel")).toBe("error");
		expect(badge?.className).not.toMatch(/violet/);
	});

	it("RiskBadge renders through StatusBadge (danger→error, mono code)", () => {
		const { container } = render(
			<RiskBadge code="UNBOUNDED_BASH" severity="danger" explanation="Bad." />,
		);
		const badge = container.querySelector(".status-badge");
		expect(badge?.getAttribute("data-channel")).toBe("error");
		expect(screen.getByText("UNBOUNDED_BASH").closest("span")?.style.fontFamily).toBe(
			"var(--font-mono)",
		);
	});

	it("SnippetStatusBadge renders through StatusBadge (outdated→neutral+pulse, post amber-sweep)", () => {
		const { container } = render(<SnippetStatusBadge status="outdated" />);
		const badge = container.querySelector(".status-badge");
		// Amber sweep (ux-narrow-color-polish): outdated is transitional, so it
		// renders neutral+ring+pulse (FreshnessBadge-stale grammar), not warn/amber.
		expect(badge?.getAttribute("data-channel")).toBe("neutral");
		expect(badge?.getAttribute("data-shape")).toBe("ring");
		expect(badge?.getAttribute("data-motion")).toBe("pulse");
	});

	it("StatePill remains a StatusBadge preset", () => {
		const { container } = render(<StatePill state="unsaved">UNSAVED</StatePill>);
		expect(container.querySelector(".status-badge.state-pill")).toBeTruthy();
	});
});

// ─── A2: migrated dialogs mount the Modal base (focus-trap + aria-modal) ──────
describe("Overlay adoption", () => {
	it("ConfirmDialog mounts the Modal base with aria-modal", () => {
		render(
			<ConfirmDialog
				open
				title="Delete?"
				onClose={() => {}}
				onConfirm={() => {}}
			/>,
		);
		const dialog = document.querySelector('.modal[role="dialog"]');
		expect(dialog).toBeTruthy();
		expect(dialog?.getAttribute("aria-modal")).toBe("true");
		expect(dialog?.className).toMatch(/confirm-dialog/);
	});

	it("Sheet is a right/center Modal preset", () => {
		render(
			<Sheet open side="right" aria-label="Wizard" onClose={() => {}}>
				<div>body</div>
			</Sheet>,
		);
		expect(document.querySelector(".modal.modal-right")).toBeTruthy();
	});

	it("PermissionsDoctorPanel renders through the Modal base", () => {
		render(
			<PermissionsDoctorPanel open findings={[]} onClose={() => {}} />,
		);
		const dialog = document.querySelector('.modal[role="dialog"]');
		expect(dialog).toBeTruthy();
		expect(screen.getByText(/Nothing flagged/)).toBeInTheDocument();
	});
});

// ─── A1: one brand-violet Toggle control (real checkbox, no ad-hoc accent) ────
describe("Toggle adoption", () => {
	it("renders a real checkbox with the tokenized skin", () => {
		const { container } = render(
			<Toggle checked onChange={() => {}} ariaLabel="x" />,
		);
		const input = container.querySelector('input[type="checkbox"]');
		expect(input).toBeTruthy();
		expect(container.querySelector(".toggle .toggle-skin")).toBeTruthy();
		// No inline accent-color override — the accent comes from the shared class.
		expect((input as HTMLElement).style.accentColor).toBe("");
	});

	it("switch variant shares the checkbox semantics", () => {
		const { container } = render(
			<Toggle variant="switch" checked={false} onChange={() => {}} ariaLabel="y" />,
		);
		expect(container.querySelector(".toggle-switch input[type='checkbox']")).toBeTruthy();
	});
});

// ─── A3: card surfaces compose the ResourceCard generic ──────────────────────
describe("ResourceCard adoption", () => {
	it("SkillCard composes ResourceCard", () => {
		const { container } = render(<SkillCard name="alpha" scope="portable" />);
		expect(container.querySelector(".resource-card.skill-card")).toBeTruthy();
		expect(container.querySelector(".resource-name")?.textContent).toBe("alpha");
	});
});

// Guard: Modal base honors min(width,92vw) so no dialog overflows narrow windows.
describe("Modal width contract", () => {
	it("renders width as min(width, 92vw)", () => {
		render(
			<Modal open width={760} onClose={() => {}} aria-label="w">
				<div>x</div>
			</Modal>,
		);
		const dialog = document.querySelector(".modal") as HTMLElement;
		expect(dialog.style.width).toBe("min(760px, 92vw)");
	});
});
