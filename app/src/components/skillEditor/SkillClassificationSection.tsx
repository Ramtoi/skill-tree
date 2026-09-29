import { useEffect, useRef, useState } from "react";
import { SidePanelSection } from "@/components/SidePanelSection";
import { ChipRadios } from "@/components/ChipRadios";
import { Button } from "@/components/Button";
import { useFocusAfterCommit } from "@/hooks/useFocusAfterCommit";
import { ClassificationValue, ContributionPathInspector } from "./ClassificationContributions";
import { ClassificationListField } from "./ClassificationListField";
import type { SkillClassification, ClassificationField, WorkingMode, InteractionStyle, Maturity } from "@/types";
import type { ClassificationContribution, ClassificationUpdateState } from "@/lib/skillClassification";
import { classificationLabel } from "@/lib/classificationCatalog";

export interface SkillClassificationSectionProps {
	classification?: SkillClassification;
	classes?: ClassificationContribution[];
	outputs?: ClassificationContribution[];
	readOnly?: boolean;
	storageKey: string;
	update?: ClassificationUpdateState["update"];
	graphPending?: boolean;
	graphError?: unknown;
	onRetryGraph?: () => void;
	graphCached?: boolean;
	embedded?: boolean;
	onInspect?: (field: "classes" | "outputs", value: string) => void;
	inspection?: { field: "classes" | "outputs"; value: string; contributors: string[]; paths: string[][]; hasMore: boolean } | null;
	onCloseInspection?: () => void;
	onOpenContributor?: (name: string) => void;
	onLoadMorePaths?: () => void;
	classSuggestions?: string[];
	outputSuggestions?: string[];
}

const enumOptions = <T extends string>(values: readonly T[]) => values.map((value) => ({ value, label: value }));
const modeOptions = enumOptions<WorkingMode>(["inline", "delegator", "mixed"]);
const interactionOptions = enumOptions<InteractionStyle>(["conversational", "checkpointed", "autonomous"]);
const maturityOptions = enumOptions<Maturity>(["experimental", "confident", "trusted"]);
const valuesFor = (classification: SkillClassification | undefined, field: "classes" | "outputs") => classification?.[field] ?? [];

export function SkillClassificationSection({ classification, classes = [], outputs = [], readOnly = false, storageKey, update, graphPending, graphError, onRetryGraph, graphCached = false, embedded = false, onInspect, inspection, onCloseInspection, onOpenContributor, onLoadMorePaths, classSuggestions = [], outputSuggestions = [] }: SkillClassificationSectionProps) {
	const [pending, setPending] = useState<ClassificationField | null>(null);
	const [behaviorError, setBehaviorError] = useState<string | null>(null);
	const [savedField, setSavedField] = useState<ClassificationField | null>(null);
	const mountedRef = useRef(true);
	const locked = readOnly || pending !== null;
	useEffect(() => {
		mountedRef.current = true;
		return () => { mountedRef.current = false; };
	}, []);

	async function saveField<K extends ClassificationField>(field: K, value: SkillClassification[K]) {
		if (!update || readOnly) return;
		if (!mountedRef.current) return;
		setPending(field);
		setBehaviorError(null);
		setSavedField(null);
		try {
			await update(field, value);
			if (mountedRef.current) setSavedField(field);
		} catch (reason) {
			if (mountedRef.current && (field === "working_mode" || field === "interaction_style" || field === "maturity")) setBehaviorError(reason instanceof Error ? reason.message : String(reason));
			throw reason;
		} finally {
			if (mountedRef.current) setPending(null);
		}
	}

	function referenceValues(field: "classes" | "outputs") {
		const values = (field === "classes" ? classes : outputs).filter((item) => item.provenance !== "assigned");
		return <>
			{values.length > 0 && <div className="classification-reference-values">
				<span>From references</span>
				<div className="classification-values" aria-label={`Referenced ${field}`}>{values.map((item) => <ClassificationValue key={`${field}-${item.value}`} field={field} value={item.value} provenance={item.provenance} onInspect={onInspect} />)}</div>
			</div>}
			{inspection?.field === field && <div className="classification-field-inspection">
				<ContributionPathInspector value={inspection.value} contributors={inspection.contributors} paths={inspection.paths} hasMore={inspection.hasMore} onOpenContributor={onOpenContributor} onLoadMore={onLoadMorePaths} />
				<Button variant="ghost" size="sm" onClick={onCloseInspection}>Close contribution</Button>
			</div>}
		</>;
	}

	const body = <div className="classification-section-body">
		<div className="classification-editor-controls">
			<div className="classification-editor-field">
				<ClassificationListField field="classes" values={valuesFor(classification, "classes")} unknownSuggestions={classSuggestions} disabled={readOnly} pending={pending !== null} onApply={(value) => saveField("classes", value)} />
				{referenceValues("classes")}
			</div>
			<div className="classification-editor-field">
				<ClassificationListField field="outputs" values={valuesFor(classification, "outputs")} unknownSuggestions={outputSuggestions} disabled={readOnly} pending={pending !== null} onApply={(value) => saveField("outputs", value)} />
				{referenceValues("outputs")}
			</div>
			<details className="classification-behavior" onToggle={() => setBehaviorError(null)}>
				<summary>Behavior</summary>
				<div className="classification-behavior-body">
					<BehaviorField label="Working mode" value={classification?.working_mode} options={modeOptions} disabled={locked} onChange={(value) => void saveField("working_mode", value).catch(() => undefined)} onClear={() => saveField("working_mode", undefined)} />
					<BehaviorField label="Interaction style" value={classification?.interaction_style} options={interactionOptions} disabled={locked} onChange={(value) => void saveField("interaction_style", value).catch(() => undefined)} onClear={() => saveField("interaction_style", undefined)} />
					<BehaviorField label="Maturity" value={classification?.maturity} options={maturityOptions} disabled={locked} onChange={(value) => void saveField("maturity", value).catch(() => undefined)} onClear={() => saveField("maturity", undefined)} />
					<p className="classification-behavior-foot">Unset values stay unset when classes and outputs change.</p>
					{behaviorError && <p className="classification-error" role="alert">Could not save behavior: {behaviorError}</p>}
				</div>
			</details>
		</div>
		{pending && <small className="text-dim" role="status">Saving {pending.replace(/_/g, " ")}…</small>}
		<span className="sr-only" role="status">{!pending && savedField ? `Saved ${savedField.replace(/_/g, " ")}` : ""}</span>
		{graphPending && <p className="text-dim" role="status">Loading reference contributions…</p>}
		{!!graphError && !graphCached && <p className="classification-error" role="alert">References unavailable. Assigned values are shown. <Button variant="ghost" size="sm" onClick={onRetryGraph}>Retry</Button></p>}
		{!!graphError && graphCached && <p className="classification-error" role="status">Reference contributions are stale. <Button variant="ghost" size="sm" onClick={onRetryGraph}>Retry</Button></p>}
	</div>;
	return embedded ? body : <SidePanelSection id="classification" title="Classification" storageKey={storageKey} defaultOpen summary={<span className="text-dim">{valuesFor(classification, "classes").map((value) => classificationLabel("classes", value)).join(" · ") || "unset"}</span>}>{body}</SidePanelSection>;
}


function BehaviorField<T extends string>({ label, value, options, disabled, onChange, onClear }: { label: string; value?: T; options: { value: T; label: string }[]; disabled: boolean; onChange: (value: T) => void; onClear: () => Promise<void> | void }) {
	const fieldRef = useRef<HTMLDivElement>(null);
	const requestFocus = useFocusAfterCommit();
	async function clear() {
		await Promise.resolve(onClear()).catch(() => undefined);
		requestFocus(() => fieldRef.current?.querySelector<HTMLInputElement>("input[type=radio]"));
	}
	return <div ref={fieldRef} className="classification-behavior-field">
		<div className="classification-field-heading"><span>{label}</span>{value ? <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void clear()} aria-label={`Clear ${label.toLocaleLowerCase()}`}>Clear</Button> : <span className="text-dim">Unset</span>}</div>
		<ChipRadios name={`classification-${label.toLocaleLowerCase().replace(/ /g, "-")}`} label={label} value={value ?? null} options={options} disabled={disabled} onChange={onChange} className="classification-choices" />
	</div>;
}
