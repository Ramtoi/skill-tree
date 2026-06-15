import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";

import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/store";
import { useHarnesses } from "@/hooks/useHarnesses";
import { queryClient } from "@/lib/queryClient";
import { HarnessGlyph } from "./HarnessGlyph";
import { harnessTint, harnessFile } from "./harnessRegistry";

export interface HarnessTargetsLineProps {
	projectName: string;
	/** Harnesses enabled globally (read-only here — managed on /harnesses). */
	globalHarnesses: string[];
	/** Per-project harness list — the mutable set the × / + operate on. */
	projectHarnesses: string[];
}

/**
 * The harness-target pills shown inside the Loadout "Sync" stat card. Each
 * effective harness renders as a pill with a hover-reveal × to remove; a
 * trailing + opens a menu of agents that can still be added.
 */
export function HarnessTargetsLine({
	projectName,
	globalHarnesses,
	projectHarnesses,
}: HarnessTargetsLineProps) {
	const harnesses = useHarnesses();
	const toast = useToast();
	const navigate = useNavigate();
	const setMutating = useAppStore((s) => s.setMutating);
	const mutating = useAppStore((s) => s.mutating);

	const [addOpen, setAddOpen] = useState(false);
	const addWrapRef = useRef<HTMLSpanElement>(null);

	const labelOf = useMemo(
		() => new Map(harnesses.map((h) => [h.id, h.label])),
		[harnesses],
	);
	const installedOf = useMemo(
		() => new Map(harnesses.map((h) => [h.id, h.installed])),
		[harnesses],
	);
	const globalSet = useMemo(() => new Set(globalHarnesses), [globalHarnesses]);
	const projectSet = useMemo(
		() => new Set(projectHarnesses),
		[projectHarnesses],
	);

	// Effective = harnesses configured for this project (global ∪ project), in
	// registry order. Not-installed-but-configured agents still show — install
	// state governs the add menu, not what's already chosen.
	const effective = harnesses.filter(
		(h) => globalSet.has(h.id) || projectSet.has(h.id),
	);
	const inUse = new Set(effective.map((h) => h.id));
	const available = harnesses.filter((h) => !inUse.has(h.id));
	const noInstalledLeft = available.every((h) => !h.installed);

	// Close add-menu on outside click + Escape.
	useEffect(() => {
		if (!addOpen) return;
		function onDown(e: MouseEvent) {
			if (!addWrapRef.current?.contains(e.target as Node)) setAddOpen(false);
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setAddOpen(false);
		}
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [addOpen]);

	async function persist(next: string[]) {
		setMutating(true);
		try {
			await invoke("project_set_harnesses", {
				project: projectName,
				harnesses: next,
			});
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
		} catch (err) {
			toast.error("Update failed", String(err));
			throw err;
		} finally {
			setMutating(false);
		}
	}

	async function remove(id: string) {
		const label = labelOf.get(id) ?? id;
		// Globally-enabled harnesses aren't in the project list — direct the user
		// to the global screen rather than silently no-op'ing.
		if (globalSet.has(id) && !projectSet.has(id)) {
			toast.push({
				kind: "info",
				title: `${label} is enabled globally`,
				body: "Manage it on the Harnesses screen.",
			});
			return;
		}
		const next = projectHarnesses.filter((h) => h !== id);
		try {
			await persist(next);
			toast.push({
				kind: "info",
				title: `${label} removed`,
				body: "Skills will stop syncing to this agent.",
			});
		} catch {
			/* surfaced in persist */
		}
	}

	async function add(id: string) {
		const label = labelOf.get(id) ?? id;
		if (!installedOf.get(id)) {
			toast.push({
				kind: "error",
				title: `${label} not installed`,
				body: "Install it locally, then come back here.",
			});
			return;
		}
		const next = [...projectHarnesses, id];
		setAddOpen(false);
		try {
			await persist(next);
			toast.push({
				kind: "success",
				title: `${label} added`,
				body: `Reads ${harnessFile(id)} at the project root.`,
			});
		} catch {
			/* surfaced in persist */
		}
	}

	return (
		<div className="harness-targets-row">
			{effective.length === 0 ? (
				<span className="harness-targets-none">no agents</span>
			) : (
				effective.map((h) => (
					<span
						key={h.id}
						className="harness-target-pill"
						data-icon-only
						style={{ ["--harness-accent" as string]: harnessTint(h.id) }}
						title={`${h.label} — reads ${harnessFile(h.id)}`}
						aria-label={`${h.label} — reads ${harnessFile(h.id)}`}
					>
						<HarnessGlyph id={h.id} label={h.label} size={16} decorative />
						<button
							type="button"
							className="harness-target-x"
							title={`Remove ${h.label}`}
							aria-label={`Remove ${h.label}`}
							disabled={mutating}
							onClick={(e) => {
								e.stopPropagation();
								void remove(h.id);
							}}
						>
							<Icon name="x" size={9} />
						</button>
					</span>
				))
			)}

			<span
				className="harness-target-addwrap"
				ref={addWrapRef}
				onClick={(e) => e.stopPropagation()}
			>
				<button
					type="button"
					className="harness-target-add"
					title="Add agent"
					aria-label="Add agent"
					aria-expanded={addOpen}
					disabled={available.length === 0 || noInstalledLeft || mutating}
					onClick={() => setAddOpen((v) => !v)}
				>
					<Icon name="plus" size={10} />
				</button>
				{addOpen && (
					<div className="harness-add-menu">
						<div className="harness-add-menu-head">Add agent</div>
						{available.length === 0 ? (
							<div className="harness-add-menu-empty">
								All installed agents in use.
							</div>
						) : (
							available.map((h) => (
								<button
									type="button"
									key={h.id}
									className="harness-add-menu-row"
									data-disabled={!h.installed || undefined}
									style={{
										["--harness-accent" as string]: harnessTint(h.id),
									}}
									onClick={() => void add(h.id)}
								>
									<HarnessGlyph id={h.id} label={h.label} size={16} decorative />
									<span className="harness-add-menu-name">
										<span>{h.label}</span>
										<span className="harness-add-menu-sub">
											reads{" "}
											<span className="text-mono">{harnessFile(h.id)}</span>
											{h.installed ? "" : " · not installed"}
										</span>
									</span>
								</button>
							))
						)}
						<button
							type="button"
							className="harness-add-menu-manage"
							onClick={() => {
								setAddOpen(false);
								navigate("/harnesses");
							}}
						>
							<Icon name="cog" size={10} /> Manage agents globally
						</button>
					</div>
				)}
			</span>
		</div>
	);
}
