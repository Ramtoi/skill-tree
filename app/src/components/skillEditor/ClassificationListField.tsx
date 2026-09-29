import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { SearchInput } from "@/components/SearchInput";
import { Toggle } from "@/components/Toggle";
import { asciiIdentity } from "@/lib/skillClassification";
import { useFocusAfterCommit } from "@/hooks/useFocusAfterCommit";
import {
	classificationAliasMatches,
	classificationLabel,
	CLASSIFICATION_CATALOG,
	searchClassificationCatalog,
	type ClassificationListField as ListField,
} from "@/lib/classificationCatalog";

interface ClassificationListFieldProps {
	field: ListField;
	values: string[];
	unknownSuggestions?: string[];
	disabled?: boolean;
	pending?: boolean;
	onApply: (values: string[]) => Promise<void>;
}

const uniqueValues = (values: string[]) => values.filter((value, index, all) =>
	all.findIndex((other) => asciiIdentity(other) === asciiIdentity(value)) === index,
);

export function ClassificationListField({ field, values, unknownSuggestions = [], disabled = false, pending = false, onApply }: ClassificationListFieldProps) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(values);
	const [query, setQuery] = useState("");
	const [customOpen, setCustomOpen] = useState(false);
	const [custom, setCustom] = useState("");
	const [error, setError] = useState<string | null>(null);
	const editButtonRef = useRef<HTMLSpanElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const editorRef = useRef<HTMLFormElement>(null);
	const mountedRef = useRef(true);
	const wasEditingRef = useRef(false);
	const requestFocus = useFocusAfterCommit();
	const id = useId();
	const label = field === "classes" ? "Classes" : "Outputs";
	const singular = field === "classes" ? "class" : "output";
	useEffect(() => {
		mountedRef.current = true;
		return () => { mountedRef.current = false; };
	}, []);
	useEffect(() => {
		if (wasEditingRef.current && !editing) editButtonRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
		wasEditingRef.current = editing;
	}, [editing]);

	useEffect(() => {
		if (!editing) setDraft(values);
	}, [editing, values]);
	useEffect(() => {
		const editor = editorRef.current;
		if (!editor) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			if (!pending && !disabled) close();
		};
		editor.addEventListener("keydown", onKeyDown);
		return () => editor.removeEventListener("keydown", onKeyDown);
	}, [editing, pending, disabled]);

	const selected = (value: string) => draft.some((item) => asciiIdentity(item) === asciiIdentity(value));
	const toggle = (value: string) => {
		setError(null);
		setDraft((current) => selected(value)
			? current.filter((item) => asciiIdentity(item) !== asciiIdentity(value))
			: [...current, value]);
	};

	const canonical = searchClassificationCatalog(field, query);
	const knownTerms = new Set(CLASSIFICATION_CATALOG[field].flatMap((entry) => [entry.value, entry.label, ...entry.aliases].map((term) => asciiIdentity(term))));
	const candidateValues = uniqueValues([...values, ...draft]);
	const candidateIds = new Set(candidateValues.map((value) => asciiIdentity(value)));
	const suggestions = uniqueValues(unknownSuggestions).filter((value) => {
		if (!query.trim() || knownTerms.has(asciiIdentity(value)) || candidateIds.has(asciiIdentity(value))) return false;
		return value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
	});
	const rawSelected = candidateValues.filter((value) => !CLASSIFICATION_CATALOG[field].some((entry) => asciiIdentity(entry.value) === asciiIdentity(value)));
	const visibleRaw = rawSelected.filter((value) => !query.trim() || value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
	const hasResults = canonical.length > 0 || suggestions.length > 0 || visibleRaw.length > 0;

	function open() {
		if (disabled || pending) return;
		setDraft(values);
		setQuery("");
		setCustom("");
		setCustomOpen(false);
		setError(null);
		setEditing(true);
		requestFocus(() => searchRef.current);
	}

	function close() {
		setEditing(false);
		setQuery("");
		setCustom("");
		setCustomOpen(false);
		setError(null);
	}

	async function apply() {
		setError(null);
		try {
			await onApply(uniqueValues(draft));
			if (!mountedRef.current) return;
			setEditing(false);
			setQuery("");
			setCustom("");
			setCustomOpen(false);
		} catch (reason) {
			if (mountedRef.current) setError(reason instanceof Error ? reason.message : String(reason));
		}
	}

	function addCustom() {
		const value = custom.trim();
		if (!value) return;
		setDraft((current) => uniqueValues([...current, value]));
		setCustom("");
	}

	return (
		<section className="classification-list-field" aria-label={label}>
			<div className="classification-field-heading">
				<strong>{label}</strong>
				<span ref={editButtonRef}><Button variant="ghost" size="sm" disabled={disabled || pending || editing} onClick={open} aria-label={`Edit ${field}`}>
					Edit
				</Button></span>
			</div>
			<div className="classification-saved-summary" aria-label={`Saved ${field}`}>
				{values.length ? uniqueValues(values).map((value) => (
					<span className="classification-saved-value" key={`${value}-${field}`} title={value}>{classificationLabel(field, value)}</span>
				)) : <span className="text-dim">Unset</span>}
			</div>
			{editing && (
				<form ref={editorRef} className="classification-list-editor" onSubmit={(event) => event.preventDefault()}>
					<SearchInput
						value={query}
						onChange={setQuery}
						inputRef={searchRef}
						placeholder={`Search ${field} or former terms`}
						inputProps={{ "aria-label": `Search ${field}`, disabled: pending || disabled }}
					/>
					<div className="classification-list-actions">
						<Button variant="ghost" size="sm" disabled={!draft.length || pending || disabled} onClick={() => setDraft([])}>Clear selection</Button>
					</div>
					{hasResults ? (
						<div className="classification-choice-list">
							{canonical.map((entry) => {
								const descriptionId = `${id}-${entry.value}-description`;
								const aliasMatches = classificationAliasMatches(entry, query);
								return (
									<div className="classification-choice" key={entry.value}>
										<Toggle id={`${id}-${entry.value}`} checked={selected(entry.value)} disabled={pending || disabled} onChange={() => toggle(entry.value)} ariaDescribedby={descriptionId} />
										<label className="classification-choice-label" htmlFor={`${id}-${entry.value}`}>{entry.label}</label>
										<div id={descriptionId} className="classification-choice-description">{entry.description}{aliasMatches.length ? <span className="classification-choice-alias">Matches former term: {aliasMatches.join(", ")}</span> : null}</div>
									</div>
								);
							})}
							{visibleRaw.map((value, index) => {
								const rawId = `${id}-raw-${index}`;
								const descriptionId = `${rawId}-description`;
								return <div className="classification-choice classification-choice-raw" key={`raw-${value}`}><Toggle id={rawId} checked={selected(value)} disabled={pending || disabled} onChange={() => toggle(value)} ariaDescribedby={descriptionId} /><label className="classification-choice-label" htmlFor={rawId}>{value}</label><div id={descriptionId} className="classification-choice-description">Existing value</div></div>;
							})}
							{suggestions.map((value, index) => {
								const suggestionId = `${id}-suggestion-${index}`;
								const descriptionId = `${suggestionId}-description`;
								return <div className="classification-choice classification-choice-suggestion" key={`suggestion-${value}`}><Toggle id={suggestionId} checked={selected(value)} disabled={pending || disabled} onChange={() => toggle(value)} ariaDescribedby={descriptionId} /><label className="classification-choice-label" htmlFor={suggestionId}>{value}</label><div id={descriptionId} className="classification-choice-description">Library suggestion</div></div>;
							})}
						</div>
					) : <p className="text-dim">No terms match “{query}”. Try an alias or add a custom value.</p>}
					{customOpen ? (
						<div className="classification-custom-input">
							<input aria-label={`Add ${singular}`} value={custom} placeholder={`Add a custom ${singular}`} onChange={(event) => setCustom(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustom(); } }} disabled={pending || disabled} />
							<Button variant="ghost" size="sm" disabled={!custom.trim() || pending || disabled} onClick={addCustom}>Add</Button>
						</div>
					) : <Button variant="ghost" size="sm" disabled={pending || disabled} onClick={() => setCustomOpen(true)}>Add custom</Button>}
					{error && <p className="classification-error" role="alert">Could not save {singular}: {error}</p>}
					<div className="classification-editor-actions">
						<Button variant="ghost" size="sm" disabled={pending} onClick={close}>Cancel</Button>
						{error && <Button variant="ghost" size="sm" disabled={pending || disabled} onClick={() => void apply()}>Retry</Button>}
						<Button variant="primary" size="sm" disabled={pending || disabled} onClick={() => void apply()}>{pending ? "Saving…" : "Apply"}</Button>
					</div>
				</form>
			)}
		</section>
	);
}
