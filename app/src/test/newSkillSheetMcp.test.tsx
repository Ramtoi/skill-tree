import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { renderWithProviders, primeRegistry } from "./helpers";
import { NewSkillSheet } from "@/components/NewSkillSheet";
import { ToastContainer } from "@/components/Toast";
import { useAppStore } from "@/store";
import { queryClient } from "@/lib/queryClient";

// ─── plans/E2.md §5 `newSkillSheetMcp.test.tsx` — cases 1-16 ─────────────────
// The New sheet's MCP path: the add-existing/scaffold chooser, the one
// stdin-only submit path (M8), the literal-secret plaque (F4/m5), and the
// post-submit toast/focus contract (m6/m7).

interface InvokeCfg {
	addJsonResponse?: (args: string[], body: string) => unknown;
	hubCmdResponse?: (cmdArgs: string[]) => { success: boolean; output: string };
}

function defaultProbe() {
	return {
		name: "context7",
		transport: "http",
		state: "ok" as const,
		tool_count: 4,
		tools: ["a", "b", "c", "d"],
		latency_ms: 120,
		protocol_version: "2024-11-05",
		unresolved_refs: [] as string[],
		env_from_shell: true,
		error: null,
		checked_at: "2026-09-06T12:00:00Z",
	};
}

function installInvoke(cfg: InvokeCfg = {}) {
	vi.mocked(invoke).mockImplementation((async (cmd: string, args?: unknown) => {
		if (cmd === "read_registry") return queryClient.getQueryData(["registry"]);
		if (cmd === "hub_cmd") {
			const cmdArgs = ((args as { args?: string[] } | undefined)?.args) ?? [];
			if (cfg.hubCmdResponse) return cfg.hubCmdResponse(cmdArgs);
			return { success: true, output: "" };
		}
		if (cmd === "mcp_add_json") {
			const a = (args as { args?: string[] } | undefined)?.args ?? [];
			const b = (args as { body?: string } | undefined)?.body ?? "{}";
			if (cfg.addJsonResponse) return cfg.addJsonResponse(a, b);
			return {
				ok: true,
				name: a[2],
				created_dir: "~/.skill-hub/mcp-servers/x",
				registered: true,
				equipped: null,
				spec: {},
				warnings: [],
				probe: a.includes("--probe") ? defaultProbe() : null,
			};
		}
		return undefined;
	}) as never);
}

function renderSheet(initialMcpMode?: "paste") {
	// `NewSkillSheet` writes probe data through the SINGLETON `queryClient`
	// (`@/lib/queryClient`, the same pattern `SkillLibrary.tsx` uses), not a
	// context-read `useQueryClient()` — so the test must render against that
	// same singleton for case 12's assertion to see the write.
	primeRegistry(queryClient);
	const onClose = vi.fn();
	const utils = renderWithProviders(
		<>
			<Routes>
				<Route
					path="/"
					element={<NewSkillSheet open onClose={onClose} initialMcpMode={initialMcpMode} />}
				/>
				<Route
					path="/skill/:name"
					element={
						<div data-testid="mcp-panel" tabIndex={-1}>
							panel
						</div>
					}
				/>
			</Routes>
			<ToastContainer />
		</>,
		{ client: queryClient },
	);
	return { ...utils, onClose, client: queryClient };
}

function selectMcpType() {
	// The `type` <select> has no programmatic label association (`Field`
	// renders the label as a sibling, not a `<label for>` wrapper) — it is
	// reliably the FIRST native select in the form (before `scope`'s, which
	// only renders once `type` is not `mcp-server` + add-existing).
	fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "mcp-server" } });
}

async function pastePlainJson(json: string) {
	const textarea = await screen.findByPlaceholderText(/mcp.example.com/);
	fireEvent.change(textarea, { target: { value: json } });
	return textarea;
}

beforeEach(() => {
	queryClient.clear();
	useAppStore.setState({ toasts: [] });
	installInvoke();
});

describe("NewSkillSheet — MCP path", () => {
	it("1. choosing MCP shows Add existing server first and Scaffold second", () => {
		renderSheet();
		selectMcpType();
		const group = screen.getByRole("radiogroup", { name: "How" });
		const radios = within(group).getAllByRole("radio");
		const labels = radios.map((r) => r.closest("label")?.textContent);
		expect(labels).toEqual(["Add existing server", "Scaffold a new server"]);
	});

	it("2. the Name field stays above both modes and is required in paste mode", () => {
		const { container } = renderSheet();
		selectMcpType();
		const name = screen.getByPlaceholderText("my-skill-name");
		expect(name).toHaveAttribute("required");
		const nameIdx = Array.from(container.querySelectorAll("input, [role=radiogroup]")).indexOf(
			name,
		);
		const modeGroup = screen.getByRole("radiogroup", { name: "How" });
		const modeIdx = Array.from(container.querySelectorAll("input, [role=radiogroup]")).indexOf(
			modeGroup,
		);
		expect(nameIdx).toBeLessThan(modeIdx);
	});

	it("3. a single-key mcpServers wrapper prefills the name, READ-ONLY (W10)", async () => {
		renderSheet();
		selectMcpType();
		await pastePlainJson(
			JSON.stringify({ mcpServers: { context7: { type: "http", url: "https://mcp.context7.com/mcp" } } }),
		);
		await waitFor(() =>
			expect(screen.getByPlaceholderText("my-skill-name")).toHaveValue("context7"),
		);
		// Already a slug — nothing to disambiguate, so no "from" hint.
		expect(screen.queryByText(/^from "/)).not.toBeInTheDocument();
		expect(screen.getByText("Name comes from the pasted key.")).toBeInTheDocument();
		// W10: the CLI decides the slug for a wrapper paste — the positional
		// is always the raw wrapper key, never whatever this field shows — so
		// an edit here is now impossible, not silently discarded.
		const input = screen.getByPlaceholderText("my-skill-name");
		expect(input).toHaveAttribute("readonly");
		fireEvent.change(input, { target: { value: "renamed" } });
		expect(input).toHaveValue("context7");
	});

	it('3b. a single-key wrapper whose key is NOT a slug prefills the slug and shows \'from "Sanity"\' (E3 rev 2 §2.8)', async () => {
		renderSheet();
		selectMcpType();
		await pastePlainJson(
			JSON.stringify({ mcpServers: { Sanity: { type: "http", url: "https://sanity.example.com/mcp" } } }),
		);
		await waitFor(() =>
			expect(screen.getByPlaceholderText("my-skill-name")).toHaveValue("sanity"),
		);
		expect(screen.getByText((_, el) => el?.textContent === 'from "Sanity"')).toBeInTheDocument();
	});

	it("4. a multi-key wrapper renders a Which server? select and never errors, and the picker drives what is submitted (C1)", async () => {
		renderSheet();
		selectMcpType();
		await pastePlainJson(
			JSON.stringify({
				mcpServers: {
					"a-srv": { type: "http", url: "https://a.example.com" },
					"b-srv": { type: "http", url: "https://b.example.com" },
				},
			}),
		);
		const combo = await screen.findByRole("combobox", { name: "Which server?" });
		fireEvent.click(combo);
		expect(screen.getByRole("option", { name: "a-srv" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "b-srv" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("option", { name: "a-srv" })); // close the menu, name defaults here anyway

		// C1: switching the picker must drive BOTH the derived Name and what
		// actually gets submitted — the name-derivation effect alone only
		// fired once, on the first paste (defaulting to "a-srv").
		await waitFor(() => expect(screen.getByPlaceholderText("my-skill-name")).toHaveValue("a-srv"));
		fireEvent.click(combo);
		fireEvent.click(screen.getByRole("option", { name: "b-srv" }));
		await waitFor(() => expect(screen.getByPlaceholderText("my-skill-name")).toHaveValue("b-srv"));

		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_add_json", expect.anything()));
		const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_add_json");
		const callArgs = (call?.[1] as { args: string[] }).args;
		const callBody = JSON.parse((call?.[1] as { body: string }).body) as {
			mcpServers: Record<string, { url: string }>;
		};
		expect(callArgs).toContain("b-srv");
		expect(callBody.mcpServers["b-srv"].url).toBe("https://b.example.com");
	});

	// ─── C1 — the paste path sends the RAW wrapper key positionally, never
	// the derived slug; `hub mcp add` refuses anything else for a wrapper
	// (`_parse_add_stdin`: "'<name>' is not a key in mcpServers"). Red before
	// the fix — the sheet used to send `trimmed` (the slug shown on screen).

	/** Mirrors what the REAL CLI does: `hub mcp add <positional>` slugifies
	 *  the positional itself and, when that differs, echoes
	 *  `renamed_from:<positional>` — exactly the shape `submitAddExisting`'s
	 *  toast-title branch reads. */
	function renamingAddJsonResponse(a: string[]) {
		const raw = a[2];
		const slug = raw.toLowerCase();
		return {
			ok: true,
			name: slug,
			created_dir: `~/.skill-hub/mcp-servers/${slug}`,
			registered: true,
			equipped: null,
			spec: {},
			warnings: raw !== slug ? [`renamed_from:${raw}`] : [],
			probe: null,
		};
	}

	it("C1a. a single-key wrapper's non-slug key ('Sanity') is sent positionally, RAW — and the toast names both the key and the registered slug", async () => {
		installInvoke({ addJsonResponse: (a) => renamingAddJsonResponse(a) });
		renderSheet();
		selectMcpType();
		await pastePlainJson(
			JSON.stringify({ mcpServers: { Sanity: { type: "http", url: "https://sanity.example.com/mcp" } } }),
		);
		await waitFor(() => expect(screen.getByPlaceholderText("my-skill-name")).toHaveValue("sanity"));
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_add_json", expect.anything()));
		const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_add_json");
		const callArgs = (call?.[1] as { args: string[] }).args;
		const callBody = JSON.parse((call?.[1] as { body: string }).body) as {
			mcpServers: Record<string, unknown>;
		};
		// The positional is the wrapper's OWN key — not the slug shown on
		// screen ("sanity") — and the body's only wrapper key agrees.
		expect(callArgs[2]).toBe("Sanity");
		expect(Object.keys(callBody.mcpServers)).toEqual(["Sanity"]);
		expect(await screen.findByText("Adopted Sanity as sanity.")).toBeInTheDocument();
	});

	it("C1b. a multi-key wrapper's PICKED non-slug key ('Sanity', not the wrapper's OTHER key) is also sent raw, positionally", async () => {
		installInvoke({ addJsonResponse: (a) => renamingAddJsonResponse(a) });
		renderSheet();
		selectMcpType();
		await pastePlainJson(
			JSON.stringify({
				mcpServers: {
					"a-srv": { type: "http", url: "https://a.example.com" },
					Sanity: { type: "http", url: "https://sanity.example.com/mcp" },
				},
			}),
		);
		const combo = await screen.findByRole("combobox", { name: "Which server?" });
		fireEvent.click(combo);
		fireEvent.click(screen.getByRole("option", { name: "Sanity" }));
		await waitFor(() => expect(screen.getByPlaceholderText("my-skill-name")).toHaveValue("sanity"));
		expect(screen.getByText((_, el) => el?.textContent === 'from "Sanity"')).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_add_json", expect.anything()));
		const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_add_json");
		const callArgs = (call?.[1] as { args: string[] }).args;
		expect(callArgs[2]).toBe("Sanity");
	});

	// ─── W10 — the Name field is READ-ONLY for the whole life of a wrapper
	// paste (single-key or multi-key): the CLI, not this field, decides the
	// slug, and there is no `--name`-style override on the stdin path
	// (`hub_cli/mcp.py:cmd_mcp_add`) to honour an edit with. Before the fix a
	// typed edit was silently discarded on submit; now it is impossible.

	it("W10. a single-key wrapper's Name field cannot be edited, and a change event is a no-op on both the DOM and the wire", async () => {
		installInvoke({ addJsonResponse: (a) => renamingAddJsonResponse(a) });
		renderSheet();
		selectMcpType();
		await pastePlainJson(
			JSON.stringify({ mcpServers: { Sanity: { type: "http", url: "https://sanity.example.com/mcp" } } }),
		);
		const input = await screen.findByPlaceholderText("my-skill-name");
		await waitFor(() => expect(input).toHaveValue("sanity"));
		expect(input).toHaveAttribute("readonly");
		// A change event (the only thing a real `readonly` attribute cannot
		// itself block in a test environment) is explicitly ignored by the
		// component's own onChange guard, not just by the browser.
		fireEvent.change(input, { target: { value: "my-sanity" } });
		expect(input).toHaveValue("sanity");
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_add_json", expect.anything()));
		const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_add_json");
		const callArgs = (call?.[1] as { args: string[] }).args;
		const callBody = JSON.parse((call?.[1] as { body: string }).body) as {
			mcpServers: Record<string, unknown>;
		};
		// The wire still carries the raw wrapper key — never the attempted
		// edit, and never even the derived slug.
		expect(callArgs[2]).toBe("Sanity");
		expect(Object.keys(callBody.mcpServers)).toEqual(["Sanity"]);
	});

	it("W10. a multi-key wrapper's Name field is also read-only once a key is picked", async () => {
		renderSheet();
		selectMcpType();
		await pastePlainJson(
			JSON.stringify({
				mcpServers: {
					"a-srv": { type: "http", url: "https://a.example.com" },
					"b-srv": { type: "http", url: "https://b.example.com" },
				},
			}),
		);
		const combo = await screen.findByRole("combobox", { name: "Which server?" });
		fireEvent.click(combo);
		fireEvent.click(screen.getByRole("option", { name: "a-srv" }));
		const input = await screen.findByPlaceholderText("my-skill-name");
		await waitFor(() => expect(input).toHaveValue("a-srv"));
		expect(input).toHaveAttribute("readonly");
		fireEvent.change(input, { target: { value: "renamed" } });
		expect(input).toHaveValue("a-srv");
	});

	// ─── W4 — a multi-key wrapper with nothing picked yet is a named,
	// discoverable dead end, not a blank well + an unexplained inert button.

	it("W4. a multi-key wrapper with nothing picked shows a named placeholder and the submit button explains why it is inert", async () => {
		renderSheet();
		selectMcpType();
		await pastePlainJson(
			JSON.stringify({
				mcpServers: {
					"a-srv": { type: "http", url: "https://a.example.com" },
					"b-srv": { type: "http", url: "https://b.example.com" },
				},
			}),
		);
		const combo = await screen.findByRole("combobox", { name: "Which server?" });
		expect(combo).toHaveTextContent("Pick which server to add");
		const submit = screen.getByRole("button", { name: /Add server/ });
		// Soft-disabled (Button.disabledReason): stays focusable, not natively
		// disabled — but the reason is discoverable and the click is inert.
		expect(submit).not.toBeDisabled();
		expect(submit).toHaveAttribute("aria-disabled", "true");
		expect(submit).toHaveAttribute("title", "Pick which server to add first.");
		fireEvent.click(submit);
		expect(invoke).not.toHaveBeenCalledWith("mcp_add_json", expect.anything());
	});

	// ─── W5 — a stdin-controlled wrapper key is bounded before it ever
	// reaches the DOM: non-printables become `�`, length is capped at 40.

	it("W5. a NUL-byte wrapper key never reaches the DOM raw — the invalid-name error is bounded", async () => {
		renderSheet();
		selectMcpType();
		const key = "a\u0000b";
		await pastePlainJson(
			JSON.stringify({ mcpServers: { [key]: { type: "http", url: "https://x.example.com" } } }),
		);
		expect(await screen.findByText(/cannot become a skill name/)).toBeInTheDocument();
		expect(document.body.textContent).not.toContain("\u0000");
		expect(screen.getByText("a�b cannot become a skill name even after lowercasing.")).toBeInTheDocument();
	});

	it("W5. a 5000-char wrapper key is capped in the 'from' hint, not rendered whole", async () => {
		// Upper-case so it slugifies to a DIFFERENT string (the hint only
		// renders when the derived slug differs from the raw key) while
		// `slugifyServerName` has no length refusal of its own — this key
		// DOES slugify, so the HINT (not the invalid-name error) is what is
		// under test here.
		const longKey = "A".repeat(5000);
		renderSheet();
		selectMcpType();
		await pastePlainJson(JSON.stringify({ mcpServers: { [longKey]: { command: "npx" } } }));
		await waitFor(() => expect(screen.getByPlaceholderText("my-skill-name")).toHaveValue("a".repeat(5000)));
		// The pasted textarea legitimately echoes back what the user typed —
		// only the HINT is under test here, so scope the "not whole" check to
		// it rather than the whole document (which also holds the raw paste).
		const hint = screen.getByText((_, el) => el?.textContent === `from "${"A".repeat(39)}…"`);
		expect(hint.textContent).not.toContain(longKey);
		expect(within(hint).getByText(`${"A".repeat(39)}…`)).toBeInTheDocument();
	});

	// ─── N10 — the raw key in the "from" hint renders as a mono identifier.

	it('N10. the from "<key>" hint renders the key in --font-mono', async () => {
		renderSheet();
		selectMcpType();
		await pastePlainJson(
			JSON.stringify({ mcpServers: { Sanity: { type: "http", url: "https://sanity.example.com/mcp" } } }),
		);
		const hint = await screen.findByText((_, el) => el?.textContent === 'from "Sanity"');
		expect(within(hint).getByText("Sanity")).toHaveStyle({ fontFamily: "var(--font-mono)" });
	});

	it("5. paste mode submits through mcp_add_json with the pasted object on stdin (W6)", async () => {
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "context7" } });
		const pasted = { type: "http", url: "https://mcp.context7.com/mcp" };
		await pastePlainJson(JSON.stringify(pasted));
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"mcp_add_json",
				expect.objectContaining({
					args: expect.arrayContaining(["mcp", "add", "context7", "--json-stdin"]),
					body: expect.any(String),
				}),
			),
		);
		const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_add_json");
		const body = JSON.parse((call?.[1] as { body: string }).body) as Record<string, unknown>;
		// W6: the object actually crossed the boundary — not just SOME string.
		expect(body).toEqual(pasted);
	});

	it("6. details mode submits through the SAME command, carrying the assembled object (W6)", async () => {
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "context7" } });
		fireEvent.click(screen.getByRole("radio", { name: "Enter details" }));
		fireEvent.change(screen.getByPlaceholderText("https://mcp.example.com/mcp"), {
			target: { value: "https://mcp.context7.com/mcp" },
		});
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_add_json", expect.anything()));
		const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_add_json");
		const callArgs = (call?.[1] as { args: string[] }).args;
		expect(callArgs).not.toContain("--header");
		const body = JSON.parse((call?.[1] as { body: string }).body) as Record<string, unknown>;
		expect(body).toEqual({ type: "http", url: "https://mcp.context7.com/mcp" });
	});

	it("7a. the pasted JSON never appears in argv, and IS present in the body (paste mode, W6)", async () => {
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "linear-mcp" } });
		await pastePlainJson(
			JSON.stringify({
				type: "http",
				url: "https://mcp.linear.app/sse",
				headers: { Authorization: "Bearer sk-live-abcdefgh12345678" },
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Keep it anyway" }));
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_add_json", expect.anything()));
		const pasteCall = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_add_json");
		const pasteArgs = JSON.stringify((pasteCall?.[1] as { args: string[] }).args);
		expect(pasteArgs).not.toContain("sk-live-abcdefgh12345678");
		expect(pasteArgs).not.toContain("Bearer");
		const body = JSON.parse((pasteCall?.[1] as { body: string }).body) as {
			headers: Record<string, string>;
		};
		expect(body.headers.Authorization).toBe("Bearer sk-live-abcdefgh12345678");
	});

	it("7b. the pasted JSON never appears in argv, and IS present in the body (details mode, W6)", async () => {
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "linear-mcp" } });
		fireEvent.click(screen.getByRole("radio", { name: "Enter details" }));
		fireEvent.change(screen.getByPlaceholderText("Bearer ${MY_TOKEN}"), {
			target: { value: "Bearer sk-live-zzzzzzzzzzzz" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Keep it anyway" }));
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_add_json", expect.anything()));
		const detailsCall = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_add_json");
		const detailsArgs = JSON.stringify((detailsCall?.[1] as { args: string[] }).args);
		expect(detailsArgs).not.toContain("sk-live-zzzzzzzzzzzz");
		expect(detailsArgs).not.toContain("Bearer");
		const body = JSON.parse((detailsCall?.[1] as { body: string }).body) as {
			headers: Record<string, string>;
		};
		expect(body.headers.Authorization).toBe("Bearer sk-live-zzzzzzzzzzzz");
	});

	it("8. a literal token shows the plaque before submit, in both modes", async () => {
		renderSheet();
		selectMcpType();
		await pastePlainJson(
			JSON.stringify({ type: "http", url: "https://x.com", headers: { Authorization: "Bearer sk-live-abcdefgh12345678" } }),
		);
		expect(await screen.findByText("A token is written in plain text")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("radio", { name: "Enter details" }));
		fireEvent.change(screen.getByPlaceholderText("Bearer ${MY_TOKEN}"), {
			target: { value: "Bearer sk-live-abcdefgh12345678" },
		});
		expect(await screen.findByText("A token is written in plain text")).toBeInTheDocument();
	});

	it("9. Replace with ${…} rewrites the value in place and keeps the scheme", async () => {
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "context7" } });
		const textarea = await pastePlainJson(
			JSON.stringify({ type: "http", url: "https://x.com", headers: { Authorization: "Bearer sk-live-abcdefgh12345678" } }),
		);
		const replaceBtn = await screen.findByRole("button", { name: /Replace with/ });
		fireEvent.click(replaceBtn);
		await waitFor(() =>
			expect((textarea as HTMLTextAreaElement).value).toContain("Bearer ${"),
		);
		expect((textarea as HTMLTextAreaElement).value).toContain("CONTEXT7_TOKEN");
	});

	it("9b. before a name is typed, Replace derives ${VAR} from the endpoint host, never a literal 'server' (C3)", async () => {
		renderSheet();
		selectMcpType();
		// Name deliberately left empty — the natural order the textarea's own
		// autofocus invites: paste → see the plaque → Replace, THEN type a name.
		const textarea = await pastePlainJson(
			JSON.stringify({
				type: "http",
				url: "https://mcp.context7.com/mcp",
				headers: { Authorization: "Bearer sk-live-abcdefgh12345678" },
			}),
		);
		const replaceBtn = await screen.findByRole("button", { name: /Replace with/ });
		expect(replaceBtn.textContent).toContain("CONTEXT7_TOKEN");
		expect(replaceBtn.textContent).not.toContain("SERVER_TOKEN");
		fireEvent.click(replaceBtn);
		await waitFor(() =>
			expect((textarea as HTMLTextAreaElement).value).toContain("${CONTEXT7_TOKEN}"),
		);
		// Naming it afterward (matching what the host already derived) and
		// submitting must keep the already-rewritten reference.
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "context7" } });
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_add_json", expect.anything()));
		const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_add_json");
		const body = JSON.parse((call?.[1] as { body: string }).body) as {
			headers: Record<string, string>;
		};
		expect(body.headers.Authorization).toBe("Bearer ${CONTEXT7_TOKEN}");
	});

	it("10. Keep it anyway adds --allow-literal to the args", async () => {
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "context7" } });
		await pastePlainJson(
			JSON.stringify({ type: "http", url: "https://x.com", headers: { Authorization: "Bearer sk-live-abcdefgh12345678" } }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Keep it anyway" }));
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"mcp_add_json",
				expect.objectContaining({ args: expect.arrayContaining(["--allow-literal"]) }),
			),
		);
	});

	it("11a. submit passes --probe and the success toast names the ok probe result", async () => {
		installInvoke({
			addJsonResponse: (a) => ({
				ok: true,
				name: a[2],
				created_dir: "x",
				registered: true,
				equipped: null,
				spec: {},
				warnings: [],
				probe: { ...defaultProbe(), name: a[2] },
			}),
		});
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "context7" } });
		await pastePlainJson(JSON.stringify({ type: "http", url: "https://mcp.context7.com/mcp" }));
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		expect(await screen.findByText("Server registered")).toBeInTheDocument();
		expect(await screen.findByText(/answered, 4 tools/)).toBeInTheDocument();
	});

	it("11b. submit passes --probe and the success toast names the unresolved_ref probe result", async () => {
		installInvoke({
			addJsonResponse: (a) => ({
				ok: true,
				name: a[2],
				created_dir: "x",
				registered: true,
				equipped: null,
				spec: {},
				warnings: [],
				probe: {
					...defaultProbe(),
					name: a[2],
					state: "unresolved_ref",
					unresolved_refs: ["CONTEXT7_TOKEN"],
				},
			}),
		});
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "context7" } });
		await pastePlainJson(JSON.stringify({ type: "http", url: "https://mcp.context7.com/mcp" }));
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		expect(await screen.findByText("Server registered")).toBeInTheDocument();
		expect(await screen.findByText(/CONTEXT7_TOKEN is not set/)).toBeInTheDocument();
	});

	it("12. the probe row primes the panel's query", async () => {
		const probe = { ...defaultProbe(), name: "context7" };
		installInvoke({
			addJsonResponse: (a) => ({
				ok: true,
				name: a[2],
				created_dir: "x",
				registered: true,
				equipped: null,
				spec: {},
				warnings: [],
				probe,
			}),
		});
		const { client } = renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "context7" } });
		await pastePlainJson(JSON.stringify({ type: "http", url: "https://mcp.context7.com/mcp" }));
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() => expect(client.getQueryData(["mcpProbe", "context7"])).toEqual(probe));
	});

	it("13a. the textarea autofocuses on mode select", async () => {
		renderSheet();
		selectMcpType();
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByPlaceholderText(/mcp.example.com/)),
		);
	});

	it("13b. ⌘Enter submits from the textarea", async () => {
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "context7" } });
		const textarea = await pastePlainJson(JSON.stringify({ type: "http", url: "https://mcp.context7.com/mcp" }));
		fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_add_json", expect.anything()));
	});

	it("14. focus lands on the panel heading after navigation", async () => {
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "context7" } });
		await pastePlainJson(JSON.stringify({ type: "http", url: "https://mcp.context7.com/mcp" }));
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("mcp-panel")), {
			timeout: 3000,
		});
	});

	it("15. Scaffold a new server still calls hub new mcp <name> (J6 regression)", async () => {
		renderSheet();
		selectMcpType();
		fireEvent.click(screen.getByRole("radio", { name: "Scaffold a new server" }));
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "brand-new-mcp" } });
		fireEvent.click(screen.getByRole("button", { name: /Create server/ }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"hub_cmd",
				expect.objectContaining({ args: expect.arrayContaining(["new", "mcp", "brand-new-mcp"]) }),
			),
		);
	});

	it("16. global is the default equip target", () => {
		renderSheet();
		selectMcpType();
		const group = screen.getByRole("radiogroup", { name: "Equip" });
		expect(within(group).getByRole("radio", { name: "Everywhere (global)" })).toBeChecked();
	});

	// ─── E3 rev 2 §5 case 22 ────────────────────────────────────────────────

	it("22a. invalid JSON on the paste renders an inline error and blocks submit", async () => {
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "srv" } });
		await pastePlainJson('{"command": "npx",');
		expect(await screen.findByText("That is not valid JSON.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Add server/ })).toBeDisabled();
	});

	it("22b. a top-level array renders its own inline error and blocks submit", async () => {
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "srv" } });
		await pastePlainJson('["not", "an", "object"]');
		expect(
			await screen.findByText("Paste a single server object, not a list."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Add server/ })).toBeDisabled();
	});

	it("22c. details mode: an argument with a space stays ONE arg (no /\\s+/ split)", async () => {
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "srv" } });
		fireEvent.click(screen.getByRole("radio", { name: "Enter details" }));
		fireEvent.click(screen.getByRole("radio", { name: "Local (stdio)" }));
		fireEvent.change(screen.getByPlaceholderText("npx"), { target: { value: "python3" } });
		fireEvent.change(screen.getByPlaceholderText("-y @scope/pkg"), {
			target: { value: "/My Docs/x.py\n--flag" },
		});
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp_add_json", expect.anything()));
		const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "mcp_add_json");
		const body = JSON.parse((call?.[1] as { body: string }).body) as { args: string[] };
		expect(body.args).toEqual(["/My Docs/x.py", "--flag"]);
	});

	it("22d. details mode: an empty stdio command refuses submit (no silent python3 default)", () => {
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "srv" } });
		fireEvent.click(screen.getByRole("radio", { name: "Enter details" }));
		fireEvent.click(screen.getByRole("radio", { name: "Local (stdio)" }));
		expect(screen.getByRole("button", { name: /Add server/ })).toBeDisabled();
	});

	it("22e. payload.warnings render in the success toast before the probe line", async () => {
		installInvoke({
			addJsonResponse: (a) => ({
				ok: true,
				name: a[2],
				created_dir: "~/.skill-hub/mcp-servers/srv",
				registered: true,
				equipped: null,
				spec: {},
				warnings: ["command_has_arguments"],
				probe: null,
			}),
		});
		renderSheet();
		selectMcpType();
		fireEvent.change(screen.getByPlaceholderText("my-skill-name"), { target: { value: "srv" } });
		await pastePlainJson(JSON.stringify({ command: "npx run-it" }));
		fireEvent.click(screen.getByRole("button", { name: /Add server/ }));
		expect(
			await screen.findByText("The command contains spaces; hub does not split it."),
		).toBeInTheDocument();
	});
});
