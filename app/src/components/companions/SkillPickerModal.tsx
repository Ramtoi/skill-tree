// Wave 4c unit 3 (plans/3.md §2.3) — the skill-picker stage of the "Ship this
// with a skill…" host. A `Modal` (a pick is a decision, not an editing
// surface — the SHEET is that), single-select over `MultiSelectList`, an
// eligible row's `meta` names it already ships the target and disables it
// (still focusable — the lit-slot rule stays: a disabled row explains
// itself via `title`, it doesn't disappear), and a dim footer line naming
// how many skills were dropped and why.

import { useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { SearchInput } from "@/components/SearchInput";
import { EmptyState } from "@/components/EmptyState";
import { MultiSelectList, type MultiSelectOption } from "@/components/MultiSelectList";
import { useRegistry } from "@/hooks/useRegistry";
import { eligibleShipTargets, type ShipWithTarget } from "@/lib/shipWith";

export interface SkillPickerModalProps {
	open: boolean;
	target: ShipWithTarget;
	onPick: (skill: string) => void;
	onClose: () => void;
}

export function SkillPickerModal({ open, target, onPick, onClose }: SkillPickerModalProps) {
	const { data: registry } = useRegistry();
	const [query, setQuery] = useState("");

	const result = useMemo(() => eligibleShipTargets(registry, target), [registry, target]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return result.eligible;
		return result.eligible.filter((s) => s.name.toLowerCase().includes(q));
	}, [result.eligible, query]);

	const options: MultiSelectOption[] = filtered.map((s) => ({
		id: s.name,
		label: s.name,
		selected: false,
		disabled: s.alreadyShips,
		// R8 — the reason a disabled row is inert must be VISIBLE (this
		// header's own §2.3 comment already promised it), not only reachable
		// by hover: `title` stays too, for the tooltip, but `meta` is what a
		// screen reader and a glance both actually see.
		meta: s.alreadyShips ? <span className="text-dim">already ships this</span> : undefined,
		title: s.alreadyShips ? "already ships this" : undefined,
	}));

	function handleToggle(id: string) {
		const row = filtered.find((s) => s.name === id);
		if (row && !row.alreadyShips) onPick(id);
	}

	return (
		<Modal
			open={open}
			onClose={onClose}
			title="Ship this with a skill…"
			width={440}
			side="center"
			className="ship-with-picker"
			footer={
				<Button variant="ghost" onClick={onClose} data-testid="ship-with-picker-cancel">
					Cancel
				</Button>
			}
		>
			<SearchInput
				value={query}
				onChange={setQuery}
				placeholder="Find a skill…"
				inputTestId="ship-with-picker-search"
			/>
			{result.eligible.length === 0 ? (
				<EmptyState
					title="No skill can ship this"
					description="Create a new skill first, then ship it with that."
				/>
			) : (
				<MultiSelectList label="Eligible skills" options={options} onToggle={handleToggle} />
			)}
			{result.blocked.count > 0 && (
				<p className="ship-with-picker-blocked" data-testid="ship-with-picker-blocked">
					{result.blocked.count} skill{result.blocked.count === 1 ? "" : "s"} can&rsquo;t ship
					companions — {result.blocked.reason}
				</p>
			)}
		</Modal>
	);
}
