import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Sheet } from "@/components/Modal";
import { Chips, Chip } from "@/components/Chips";
import { EmptyState } from "@/components/EmptyState";
import { useMcpCatalog } from "@/hooks/useMcpCatalog";
import {
	annotationChips,
	catalogFetchErrorLine,
	parameterTypeLabel,
	titledLabel,
	truncationLine,
	ANNOTATION_HINT_TITLE,
	type McpCatalog,
	type McpCatalogKind,
	type McpCatalogPrompt,
	type McpCatalogResource,
	type McpCatalogResourceTemplate,
	type McpCatalogTool,
	type McpToolParameter,
} from "@/lib/mcpContract";

export interface McpCapabilitySheetProps {
	name: string;
	open: boolean;
	onClose: () => void;
}

type FlatItem =
	| { kind: "tools"; key: string; item: McpCatalogTool }
	| { kind: "resources"; key: string; item: McpCatalogResource }
	| { kind: "resource_templates"; key: string; item: McpCatalogResourceTemplate }
	| { kind: "prompts"; key: string; item: McpCatalogPrompt };

const KIND_HEADING: Record<McpCatalogKind, string> = {
	tools: "TOOLS",
	resources: "RESOURCES",
	resource_templates: "TEMPLATES",
	prompts: "PROMPTS",
};

const METHOD_TO_KIND: Record<string, McpCatalogKind> = {
	"tools/list": "tools",
	"resources/list": "resources",
	"resources/templates/list": "resource_templates",
	"prompts/list": "prompts",
};

// `FlatItem` is a REAL discriminated union (each arm declared directly, not
// derived via `Pick`/`Omit`) — that is load-bearing. `Pick<FlatItem, "kind" |
// "item">` looked equivalent but ISN'T: `Pick` over a union computes its
// result from the union of every member's own property types, which
// collapses `item`'s type back to the full four-way union regardless of
// `kind` and defeats narrowing entirely (a `row.kind === "resources"` check
// stopped narrowing `row.item` at all). Every helper below takes the real
// `FlatItem` — or, where a key isn't available yet (`groups`, mid-construction),
// narrows using a plain kind-tagged literal argument instead of `Pick`.
function itemName(row: FlatItem): string {
	switch (row.kind) {
		case "resources":
			return row.item.uri;
		case "resource_templates":
			return row.item.uri_template;
		case "tools":
		case "prompts":
			return row.item.name;
	}
}

/** Filters by name, title and description — plans/G.md §7 ("Search filtering
 *  all kinds by name and description"), title included since rev 3 makes it
 *  the primary label a user actually reads. */
function textMatches(name: string, title: string | null | undefined, description: string | null, q: string): boolean {
	if (!q) return true;
	if (name.toLowerCase().includes(q)) return true;
	if (title && title.toLowerCase().includes(q)) return true;
	return !!description && description.toLowerCase().includes(q);
}

/**
 * The browse sheet (plans/G.md §7) — `Sheet` gives the portal, scrim, focus
 * trap and Esc; this component owns only the two-pane layout, search, and
 * selection. All server-authored text renders as PLAIN TEXT (never
 * `renderMarkdown` — that primitive has an open frontmatter-leak defect and
 * this text is attacker-controlled).
 */
export function McpCapabilitySheet({ name, open, onClose }: McpCapabilitySheetProps) {
	const catalogQuery = useMcpCatalog(name, open);
	const [search, setSearch] = useState("");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const searchRef = useRef<HTMLInputElement | null>(null);
	const rowRefs = useRef(new Map<string, HTMLButtonElement>());

	useEffect(() => {
		if (!open) {
			setSearch("");
			setSelectedKey(null);
		}
	}, [open]);

	const payload = catalogQuery.data;
	const record: McpCatalog | null = payload && payload.ok ? payload.catalog : null;
	const q = search.trim().toLowerCase();

	// `Modal`'s own `initialFocus` runs on a single rAF right after mount, so
	// it cannot reach the search field: this sheet's body is async (the
	// catalogue is still loading then, so the `<input>` isn't in the DOM
	// yet). Focus it explicitly the moment it appears instead — overriding
	// whatever Modal's generic fallback (the header's Close button) grabbed.
	useEffect(() => {
		if (open && record) searchRef.current?.focus();
	}, [open, record]);

	const erroredKinds = useMemo(() => {
		const set = new Set<McpCatalogKind>();
		if (!record) return set;
		for (const err of record.fetch_errors) {
			const kind = METHOD_TO_KIND[err.method];
			if (kind) set.add(kind);
		}
		return set;
	}, [record]);

	const groups = useMemo(() => {
		const out: { kind: McpCatalogKind; rawCount: number; items: FlatItem[] }[] = [];
		if (!record) return out;
		if (record.offered.tools || erroredKinds.has("tools")) {
			const items: FlatItem[] = record.tools
				.filter((t) => textMatches(t.name, t.title, t.description, q))
				.map((t) => ({ kind: "tools", item: t, key: `tools:${t.name}` }));
			out.push({ kind: "tools", rawCount: record.tools.length, items });
		}
		if (record.offered.resources || erroredKinds.has("resources")) {
			const items: FlatItem[] = record.resources
				.filter((r) => textMatches(r.uri, r.title, r.description, q))
				.map((r) => ({ kind: "resources", item: r, key: `resources:${r.uri}` }));
			out.push({ kind: "resources", rawCount: record.resources.length, items });
		}
		if (record.offered.resource_templates || erroredKinds.has("resource_templates")) {
			const items: FlatItem[] = record.resource_templates
				.filter((t) => textMatches(t.uri_template, t.title, t.description, q))
				.map((t) => ({ kind: "resource_templates", item: t, key: `resource_templates:${t.uri_template}` }));
			out.push({ kind: "resource_templates", rawCount: record.resource_templates.length, items });
		}
		if (record.offered.prompts || erroredKinds.has("prompts")) {
			const items: FlatItem[] = record.prompts
				.filter((p) => textMatches(p.name, p.title, p.description, q))
				.map((p) => ({ kind: "prompts", item: p, key: `prompts:${p.name}` }));
			out.push({ kind: "prompts", rawCount: record.prompts.length, items });
		}
		return out;
		// `erroredKinds` is what admits an UNKNOWN group for a kind whose fetch
		// failed (review finding F6). It is itself memoised on `record`, so today
		// it only changes when `record` does — but omitting it from the deps
		// turns that into an invariant the next edit can silently break, and the
		// failure mode is a stale group list that drops the unknown groups
		// entirely: exactly the "server offers nothing" lie F6 exists to prevent.
	}, [record, q, erroredKinds]);

	const flatVisible = useMemo(() => groups.flatMap((g) => g.items), [groups]);
	const selected = flatVisible.find((r) => r.key === selectedKey) ?? null;

	// Scrolls the newly-selected row into view WITHOUT moving real DOM focus —
	// the standard palette/combobox pattern keeps focus in the search field
	// (focused above, once it mounts) so ↑/↓ and typing compose freely, the
	// same way GitHub's/VS Code's command palettes work.
	useEffect(() => {
		if (selectedKey) rowRefs.current.get(selectedKey)?.scrollIntoView({ block: "nearest" });
	}, [selectedKey]);

	function moveSelection(delta: number) {
		if (flatVisible.length === 0) return;
		const idx = flatVisible.findIndex((r) => r.key === selectedKey);
		const nextIdx =
			idx === -1 ? (delta > 0 ? 0 : flatVisible.length - 1) : (idx + delta + flatVisible.length) % flatVisible.length;
		setSelectedKey(flatVisible[nextIdx].key);
	}

	function onBodyKeyDown(e: KeyboardEvent<HTMLDivElement>) {
		const inSearch = document.activeElement === searchRef.current;
		// "/" is a no-op while already in the search field — the character
		// simply types normally, native input behaviour, never hijacked.
		if (e.key === "/" && !inSearch) {
			e.preventDefault();
			searchRef.current?.focus();
			return;
		}
		// ↑/↓ work regardless of focus, INCLUDING while typing in search — a
		// single-line `<input>` has no native meaning for these keys, so
		// `preventDefault` costs nothing there and gains "type to filter,
		// arrow to pick" in one motion.
		if (e.key === "ArrowDown") {
			e.preventDefault();
			moveSelection(1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			moveSelection(-1);
		}
	}

	const anyTruncated = !!record && Object.values(record.truncated).some(Boolean);

	return (
		<Sheet
			open={open}
			onClose={onClose}
			title={`${name} · capabilities`}
			side="right"
			width={760}
			className="mcp-capability-sheet"
		>
			{/* `role="presentation"`: this wrapper carries no meaning of its own
			    (same pattern as CompanionRow.tsx) — it only relays a bubbled
			    keydown from its focusable children (search input, rail row
			    buttons) for the ↑/↓/`/` shortcuts. It is never itself a focus
			    target, and every real control inside stays in the tab order. */}
			<div className="mcp-capability-sheet-body" role="presentation" onKeyDown={onBodyKeyDown}>
				{catalogQuery.isLoading ? (
					<div className="mcp-block-note">Reading the catalogue…</div>
				) : !record ? (
					<EmptyState
						icon="mcp"
						title="No catalogue to browse"
						description={
							payload && !payload.ok
								? "The stored catalogue is gone. Check again to read it."
								: "This check did not read the server's catalogue."
						}
					/>
				) : (
					<>
						<div className="mcp-sheet-rail">
							<input
								ref={searchRef}
								type="search"
								className="mcp-sheet-search"
								placeholder="Search tools, resources, prompts…"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								aria-label="Search capabilities"
								data-testid="mcp-sheet-search"
							/>
							<div className="mcp-sheet-rail-scroll" data-testid="mcp-sheet-rail">
								{groups.map(({ kind, items, rawCount }) => (
									<div className="mcp-sheet-rail-group" key={kind}>
										<div className="mcp-sheet-rail-heading">
											{KIND_HEADING[kind]} {erroredKinds.has(kind) ? "— unknown" : items.length}
										</div>
										{items.map((row) => {
											const label = titledLabel(itemName(row), row.item.title);
											return (
												<button
													key={row.key}
													ref={(el) => {
														if (el) rowRefs.current.set(row.key, el);
														else rowRefs.current.delete(row.key);
													}}
													type="button"
													className="mcp-sheet-rail-row"
													data-selected={row.key === selectedKey || undefined}
													data-testid="mcp-sheet-row"
													title={label.secondary ? `${label.primary} (${label.secondary})` : label.primary}
													onClick={() => setSelectedKey(row.key)}
												>
													{label.primary}
												</button>
											);
										})}
										{record.truncated[kind] && (
											<div className="mcp-block-note">{truncationLine(kind, rawCount)}</div>
										)}
									</div>
								))}
								{flatVisible.length === 0 && (
									<div className="mcp-block-note">{q ? `Nothing matches "${search.trim()}".` : "Nothing to show."}</div>
								)}
								{record.instructions != null || record.protocol_fallback ? (
									<details className="mcp-sheet-instructions">
										<summary>Server instructions</summary>
										{record.instructions && <p>{record.instructions}</p>}
										{record.protocol_fallback && (
											<p className="mcp-sheet-fallback-note">
												This server did not accept the newer protocol version — Skill Tree fell
												back to an older one.
											</p>
										)}
									</details>
								) : null}
								{anyTruncated || record.bytes_truncated ? (
									<div className="mcp-block-note">
										The stored catalogue was cut off. Some items may be missing.
									</div>
								) : null}
							</div>
						</div>
						<div className="mcp-sheet-detail" data-testid="mcp-sheet-detail">
							{!selected ? (
								<div className="mcp-block-note">
									{flatVisible.length === 0
										? q
											? `Nothing matches "${search.trim()}".`
											: "Nothing to show."
										: "Select an item from the list to see its details."}
								</div>
							) : (
								<CapabilityDetail row={selected} />
							)}
							{record.fetch_errors.length > 0 && (
								<div className="mcp-sheet-errors">
									{record.fetch_errors.map((err, i) => (
										<div key={i} className="mcp-block-note" data-tone="error">
											{catalogFetchErrorLine(err)}
										</div>
									))}
								</div>
							)}
						</div>
					</>
				)}
			</div>
		</Sheet>
	);
}

function CapabilityDetail({ row }: { row: FlatItem }) {
	const label = titledLabel(itemName(row), row.item.title);
	const heading = (
		<h3 className="mcp-sheet-detail-title" title={label.secondary ? `${label.primary} (${label.secondary})` : label.primary}>
			{label.primary}
			{label.secondary && <span className="mcp-sheet-detail-subtitle"> ({label.secondary})</span>}
		</h3>
	);

	if (row.kind === "tools") {
		const tool = row.item;
		const chips = annotationChips(tool.annotations);
		return (
			<div data-testid="mcp-sheet-tool-detail">
				{heading}
				{tool.description && <p className="mcp-sheet-description">{tool.description}</p>}
				{chips.length > 0 && (
					<Chips ariaLabel="Server-declared tool hints">
						{chips.map((c) => (
							<Chip key={c.key} title={ANNOTATION_HINT_TITLE}>
								{c.label}
							</Chip>
						))}
					</Chips>
				)}
				<ParametersTable
					title="PARAMETERS"
					schemaUnreadable={tool.schema_unreadable}
					truncated={tool.parameters_truncated}
					parameters={tool.parameters}
					emptyLabel="Takes no parameters."
					unreadableLabel="This tool declares no readable parameters."
				/>
				{(tool.output_schema_present || (tool.output_parameters && tool.output_parameters.length > 0)) && (
					<details className="mcp-sheet-returns">
						<summary>RETURNS</summary>
						<ParametersTable
							title="RETURNS"
							schemaUnreadable={!!tool.output_schema_unreadable}
							truncated={false}
							parameters={tool.output_parameters ?? []}
							emptyLabel="No return fields declared."
							unreadableLabel="This tool declares no readable return shape."
						/>
					</details>
				)}
			</div>
		);
	}

	if (row.kind === "resources") {
		const res = row.item;
		return (
			<div data-testid="mcp-sheet-resource-detail">
				{heading}
				<div className="mcp-block-note mcp-sheet-uri" title={res.uri}>
					{res.uri}
				</div>
				{res.mime_type && <div className="mcp-block-note">{res.mime_type}</div>}
				{res.description && <p className="mcp-sheet-description">{res.description}</p>}
			</div>
		);
	}

	if (row.kind === "resource_templates") {
		const tpl = row.item;
		return (
			<div data-testid="mcp-sheet-template-detail">
				{heading}
				<div className="mcp-block-note mcp-sheet-uri" title={tpl.uri_template}>
					<TemplateUri uriTemplate={tpl.uri_template} />
				</div>
				{tpl.mime_type && <div className="mcp-block-note">{tpl.mime_type}</div>}
				{tpl.description && <p className="mcp-sheet-description">{tpl.description}</p>}
			</div>
		);
	}

	const prompt = row.item;
	return (
		<div data-testid="mcp-sheet-prompt-detail">
			{heading}
			{prompt.description && <p className="mcp-sheet-description">{prompt.description}</p>}
			<table className="mcp-params-table" data-testid="mcp-arguments-table">
				<thead>
					<tr>
						<th>Name</th>
						<th>Required</th>
						<th>Description</th>
					</tr>
				</thead>
				<tbody>
					{prompt.arguments.length === 0 ? (
						<tr>
							<td colSpan={3} className="mcp-block-note">
								Takes no arguments.
							</td>
						</tr>
					) : (
						prompt.arguments.map((a) => (
							<tr key={a.name}>
								<td className="mcp-param-name" title={a.name}>
									{a.name}
								</td>
								<td className="mcp-param-required" data-required={a.required || undefined}>
									{a.required ? "required" : "—"}
								</td>
								<td className="mcp-param-description">
									{a.description && <span title={a.description}>{a.description}</span>}
								</td>
							</tr>
						))
					)}
				</tbody>
			</table>
		</div>
	);
}

function ParametersTable({
	schemaUnreadable,
	truncated,
	parameters,
	emptyLabel,
	unreadableLabel,
}: {
	title: string;
	schemaUnreadable: boolean;
	truncated: boolean;
	parameters: McpToolParameter[];
	emptyLabel: string;
	unreadableLabel: string;
}) {
	if (schemaUnreadable) {
		return <div className="mcp-block-note">{unreadableLabel}</div>;
	}
	if (parameters.length === 0) {
		return <div className="mcp-block-note">{emptyLabel}</div>;
	}
	return (
		<table className="mcp-params-table" data-testid="mcp-parameters-table">
			<thead>
				<tr>
					<th>Name</th>
					<th>Type</th>
					<th>Required</th>
					<th>Description</th>
				</tr>
			</thead>
			<tbody>
				{parameters.map((p) => (
					<tr key={p.name}>
						<td className="mcp-param-name" title={p.name}>
							{p.name}
						</td>
						<td className="mcp-param-type">{parameterTypeLabel(p)}</td>
						<td className="mcp-param-required" data-required={p.required || undefined}>
							{p.required ? "required" : "—"}
						</td>
						<td className="mcp-param-description">
							{p.description && <div title={p.description}>{p.description}</div>}
							{(p.enum || p.default !== null) && (
								<div className="mcp-param-meta">
									{p.enum && (
										<span>
											enum: {p.enum.join(", ")}
											{p.enum_truncated ? "…" : ""}
										</span>
									)}
									{p.default !== null && p.default !== undefined && <span>default: {String(p.default)}</span>}
								</div>
							)}
						</td>
					</tr>
				))}
			</tbody>
			{truncated && (
				<tfoot>
					<tr>
						<td colSpan={4} className="mcp-block-note">
							Showing the first {parameters.length} parameters. More were left out.
						</td>
					</tr>
				</tfoot>
			)}
		</table>
	);
}

function TemplateUri({ uriTemplate }: { uriTemplate: string }) {
	const parts = uriTemplate.split(/(\{[^}]*\})/g);
	return (
		<span>
			{parts.map((part, i) =>
				part.startsWith("{") && part.endsWith("}") ? (
					<span key={i} className="mcp-template-placeholder">
						{part}
					</span>
				) : (
					<span key={i}>{part}</span>
				),
			)}
		</span>
	);
}
