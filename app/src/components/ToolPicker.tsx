import { useMemo, useState } from "react";
import { Icon } from "./Icon";
import { SearchInput } from "./SearchInput";
import { Toggle } from "./Toggle";
import type { ToolGroup } from "@/lib/hookCatalog";

export interface ToolPickerProps {
	/** Currently selected tool tokens (order preserved — it is the saved order). */
	value: string[];
	onChange: (tools: string[]) => void;
	groups: ToolGroup[];
	disabled?: boolean;
}

/** Groups that start OPEN. Everything else is one click away (D2). */
const DEFAULT_OPEN = new Set(["common"]);

/**
 * Progressive-disclosure tool picker (hook-editor-redesign D2). Replaces the flat
 * ~50-checkbox wall: selected tools ride at the top as removable chips, and the
 * vocabulary sits below in collapsible groups with a filter across ALL of them.
 *
 * Filtering auto-expands any group with a match, so a token buried in a collapsed
 * group is always reachable by typing — the collapse is a default, never a
 * hiding place. Selected-but-filtered-out tools stay visible as chips, so the
 * picker can never misreport what the hook matches.
 */
export function ToolPicker({ value, onChange, groups, disabled }: ToolPickerProps) {
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState<Record<string, boolean>>({});

	const q = query.trim().toLowerCase();
	const selected = useMemo(() => new Set(value), [value]);

	const filtered = useMemo(() => {
		if (!q) return groups;
		return groups
			.map((g) => ({
				...g,
				tools: g.tools.filter((t) => t.toLowerCase().includes(q)),
			}))
			.filter((g) => g.tools.length > 0);
	}, [groups, q]);

	function toggle(tool: string) {
		if (disabled) return;
		onChange(
			selected.has(tool) ? value.filter((t) => t !== tool) : [...value, tool],
		);
	}

	function isOpen(id: string): boolean {
		// A live filter opens every group that still has a match: hiding results
		// behind a collapsed header is the exact failure the search is meant to fix.
		if (q) return true;
		return open[id] ?? DEFAULT_OPEN.has(id);
	}

	return (
		<div className="tool-picker">
			<div className="tool-picker-selected" aria-label="Selected tools">
				{value.length === 0 ? (
					<span className="text-dim tool-picker-none">
						No tools selected yet — pick at least one below.
					</span>
				) : (
					value.map((tool) => (
						<span key={tool} className="tool-chip">
							<span className="text-mono">{tool}</span>
							{!disabled && (
								<button
									type="button"
									className="tool-chip-x"
									aria-label={`Remove ${tool}`}
									onClick={() => toggle(tool)}
								>
									<Icon name="x" size={10} />
								</button>
							)}
						</span>
					))
				)}
			</div>

			{/* `screenSearch` wires this to the global `/` hotkey. SearchInput paints
			    a `/` hint that COMPONENTS.md requires to actually work, and this is
			    the only search box the hook editor ever shows — it exists exactly
			    when the picker does. */}
			<SearchInput
				value={query}
				onChange={setQuery}
				placeholder="Filter tools…"
				className="tool-picker-search"
				screenSearch
			/>

			<div className="tool-picker-groups">
				{filtered.length === 0 && (
					<div className="text-dim tool-picker-empty">
						No tool matches “{query}”.
					</div>
				)}
				{filtered.map((g) => {
					const expanded = isOpen(g.id);
					const chosen = g.tools.filter((t) => selected.has(t)).length;
					return (
						<div className="tool-group" key={g.id} data-open={expanded || undefined}>
							<button
								type="button"
								className="tool-group-head"
								aria-expanded={expanded}
								onClick={() =>
									setOpen((prev) => ({ ...prev, [g.id]: !expanded }))
								}
							>
								<Icon name={expanded ? "chevron-down" : "chevron-right"} size={11} />
								<span className="tool-group-label">{g.label}</span>
								<span className="tool-group-count">
									{chosen > 0 ? `${chosen}/${g.tools.length}` : g.tools.length}
								</span>
							</button>
							{expanded && (
								<div className="tool-group-body" role="group" aria-label={g.label}>
									{g.tools.map((tool) => (
										<Toggle
											key={tool}
											checked={selected.has(tool)}
											onChange={() => toggle(tool)}
											disabled={disabled}
											size="sm"
											label={<span className="text-mono">{tool}</span>}
										/>
									))}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
