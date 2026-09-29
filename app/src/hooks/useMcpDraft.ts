import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/ipc";
import { runHubCmd } from "@/lib/hubCmd";
import { invalidateRegistry } from "@/lib/invalidate";
import { errText } from "@/lib/hubWrite";
import { parseCliJson } from "@/lib/skillPack";
import { useToast } from "@/components/Toast";
import { UNDO_TOAST_DURATION_MS } from "@/hooks/useUndoableAction";
import { suggestRef, literalSecretKeysOf, type McpSetResult } from "@/lib/mcpContract";
import type { McpSpec, Skill } from "@/types";

/** The `mcp:` block fields a save can express through argv (M8: never the
 *  credential fields — those go through `mcp_set_json` on stdin). */
type ArgvField = "transport" | "url" | "command" | "args" | "cwd" | "timeout_ms";

/** The two fields whose VALUES are credential-shaped often enough that a
 *  changed value on either one routes the whole save through stdin (M8). */
const CREDENTIAL_FIELDS = ["headers", "env"] as const;

const SPEC_KEYS = [
	"transport",
	"command",
	"args",
	"env",
	"cwd",
	"url",
	"headers",
	"timeout_ms",
	"allow_literal_secrets",
] as const satisfies readonly (keyof McpSpec)[];

/** Every top-level `mcp:` key whose value differs between `base` and `next` —
 *  the same `changed_keys` grammar `hub mcp set --json` reports. `runtime` is
 *  excluded: it is a legacy passthrough field the UI never edits. */
function changedKeys(base: McpSpec, next: McpSpec): (keyof McpSpec)[] {
	return SPEC_KEYS.filter(
		(key) => JSON.stringify(base[key] ?? null) !== JSON.stringify(next[key] ?? null),
	);
}

function isCredentialField(key: keyof McpSpec): boolean {
	return (CREDENTIAL_FIELDS as readonly string[]).includes(key);
}

/** `hub mcp set <name> [flags…] --json` — one flag per changed non-credential
 *  field (case 15: a lone `url` change pins `["mcp","set",name,"--url",v,"--json"]`).
 *  A transport swap drops the other half's stale fields SERVER-SIDE
 *  (`_spec_from_flags`'s `stdio_base`/`remote_base` — review W4); this only
 *  has to name what actually changed on the client.
 *
 *  `args` never actually reaches this function today — any `args` change
 *  routes through the stdin path instead (C4 below), which is what protects
 *  a dash-led value (`npx -y <pkg>`) from argparse. The `--arg=${a}` form
 *  (review C1) is kept here as defensive belt-and-braces (exported and
 *  unit-tested directly, see `mcpPanel.test.tsx`'s `buildArgvArgs` describe)
 *  in case a future change ever re-opens an argv path for it: a bare
 *  `--arg -y` would make argparse treat `-y` as a flag of its own
 *  (`argument --arg: expected one argument`) — `--arg=-y` never does. */
export function buildArgvArgs(name: string, changed: (keyof McpSpec)[], spec: McpSpec): string[] {
	const args = ["mcp", "set", name];
	for (const key of changed as ArgvField[]) {
		switch (key) {
			case "transport":
				args.push("--transport", spec.transport ?? "stdio");
				break;
			case "url":
				args.push("--url", spec.url ?? "");
				break;
			case "command":
				args.push("--command", spec.command ?? "");
				break;
			case "args":
				for (const a of spec.args ?? []) args.push(`--arg=${a}`);
				break;
			case "cwd":
				args.push("--cwd", spec.cwd ?? "");
				break;
			case "timeout_ms":
				if (spec.timeout_ms != null) args.push("--timeout-ms", String(spec.timeout_ms));
				break;
		}
	}
	args.push("--json");
	return args;
}

/** Per-key patch for a nested `headers`/`env` map (C4 — INTERFACES §3:
 *  "a `null` value inside a nested dict of the `hub mcp set --json-stdin`
 *  body DELETES that key, and a list value REPLACES the list"): a key
 *  present in `base` but missing from `next` becomes an explicit `null`;
 *  every added/changed key carries its new literal value. Keys that did not
 *  change are omitted entirely — the stdin body is a PATCH, not a snapshot. */
function keyValuePatch(
	base: Record<string, string> | undefined,
	next: Record<string, string> | undefined,
): Record<string, string | null> {
	const patch: Record<string, string | null> = {};
	const baseMap = base ?? {};
	const nextMap = next ?? {};
	for (const key of Object.keys(baseMap)) {
		if (!(key in nextMap)) patch[key] = null;
	}
	for (const [key, value] of Object.entries(nextMap)) {
		if (baseMap[key] !== value) patch[key] = value;
	}
	return patch;
}

/** Validation — the ONE blocking rule (§4.2): a remote transport with an
 *  empty URL. Every other caveat in the design (an absent stdio command, a
 *  malformed-looking URL) is a warning line, never a save-blocker (M3). */
function computeErrors(spec: McpSpec): Record<string, string> {
	const errors: Record<string, string> = {};
	const transport = spec.transport ?? "stdio";
	if ((transport === "http" || transport === "sse") && !(spec.url ?? "").trim()) {
		errors.url = "A remote server needs a URL.";
	}
	return errors;
}

export interface UseMcpDraft {
	spec: McpSpec;
	/** The last-loaded (saved) spec — the CONNECTION block reads this to
	 *  decide whether a transport switch has anything "kept until you save". */
	original: McpSpec;
	dirty: boolean;
	saving: boolean;
	errors: Record<string, string>;
	saveDisabled: boolean;
	set: (patch: Partial<McpSpec>) => void;
	addHeader: (key: string, value: string) => void;
	removeHeader: (key: string) => void;
	addEnv: (key: string, value: string) => void;
	removeEnv: (key: string) => void;
	/** Replaces a literal secret value with a `${VAR}` reference (m5): keeps a
	 *  leading auth scheme, marks the draft dirty, and toasts the derived
	 *  variable name. */
	replaceWithRef: (key: string) => void;
	reset: () => void;
	save: () => Promise<void>;
}

/**
 * The MCP editor panel's draft state (plans/E1.md §3/§4.6). Hydrates from
 * `skill.mcp` whenever the underlying block actually changes (not merely on
 * every registry refetch — a byte-identical re-hydration would otherwise
 * clobber an in-progress edit the moment an unrelated `invalidateRegistry()`
 * elsewhere in the app re-ran the registry query).
 */
export function useMcpDraft(name: string, skill: Skill | undefined): UseMcpDraft {
	const toast = useToast();
	const [spec, setSpec] = useState<McpSpec>(() => skill?.mcp ?? {});
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const baseSpecRef = useRef<McpSpec>(skill?.mcp ?? {});
	const hydratedKeyRef = useRef<string | null>(null);

	useEffect(() => {
		const base = skill?.mcp ?? {};
		const key = `${name}:${JSON.stringify(base)}`;
		if (hydratedKeyRef.current === key) return;
		hydratedKeyRef.current = key;
		baseSpecRef.current = base;
		setSpec(base);
		setDirty(false);
	}, [name, skill]);

	const set = useCallback((patch: Partial<McpSpec>) => {
		setSpec((prev) => ({ ...prev, ...patch }));
		setDirty(true);
	}, []);

	const addHeader = useCallback((key: string, value: string) => {
		setSpec((prev) => ({ ...prev, headers: { ...(prev.headers ?? {}), [key]: value } }));
		setDirty(true);
	}, []);

	const removeHeader = useCallback((key: string) => {
		setSpec((prev) => {
			const headers = { ...(prev.headers ?? {}) };
			delete headers[key];
			return { ...prev, headers };
		});
		setDirty(true);
	}, []);

	const addEnv = useCallback((key: string, value: string) => {
		setSpec((prev) => ({ ...prev, env: { ...(prev.env ?? {}), [key]: value } }));
		setDirty(true);
	}, []);

	const removeEnv = useCallback((key: string) => {
		setSpec((prev) => {
			const env = { ...(prev.env ?? {}) };
			delete env[key];
			return { ...prev, env };
		});
		setDirty(true);
	}, []);

	const replaceWithRef = useCallback(
		(key: string) => {
			const isRemote = (spec.transport ?? "stdio") !== "stdio";
			const bucketKey: "headers" | "env" = isRemote ? "headers" : "env";
			const currentValue = (spec[bucketKey] ?? {})[key];
			if (currentValue === undefined) return;
			const { value: newValue, varName } = suggestRef(name, key, currentValue);
			setSpec((prev) => ({
				...prev,
				[bucketKey]: { ...(prev[bucketKey] ?? {}), [key]: newValue },
			}));
			setDirty(true);
			toast.push({
				kind: "success",
				title: "Replaced with a reference",
				body: `Set ${varName} in your shell before the harness starts.`,
			});
		},
		[spec, name, toast],
	);

	const reset = useCallback(() => {
		setSpec(baseSpecRef.current);
		setDirty(false);
	}, []);

	const errors = computeErrors(spec);
	const saveDisabled = dirty && Object.keys(errors).length > 0;

	const save = useCallback(async () => {
		if (!dirty || saving || Object.keys(computeErrors(spec)).length > 0) return;
		setSaving(true);
		try {
			const base = baseSpecRef.current;
			const changed = changedKeys(base, spec);
			if (changed.length === 0) {
				setDirty(false);
				return;
			}
			// C2: a URL carrying a credential-flagged query param must never
			// reach argv either — `literalSecretKeysOf` already emits
			// `url.query:<key>` tokens for exactly this shape (m9).
			const urlHasCredentialQuery =
				changed.includes("url") &&
				literalSecretKeysOf(spec).some((k) => k.startsWith("url.query:"));
			// C4 (INTERFACES §3, Change control): a `null` inside a nested
			// headers/env dict DELETES that key server-side, and a list value
			// (args) REPLACES the list wholesale — both only expressible over
			// stdin, so a header/env change and ANY args change (including
			// clearing to zero) always route there, never through argv.
			const usesStdin =
				changed.some(isCredentialField) || changed.includes("args") || urlHasCredentialQuery;
			let result: McpSetResult;
			if (usesStdin) {
				const body: Record<string, unknown> = {};
				for (const key of changed) {
					if (key === "headers") body.headers = keyValuePatch(base.headers, spec.headers);
					else if (key === "env") body.env = keyValuePatch(base.env, spec.env);
					else body[key] = spec[key] ?? null;
				}
				result = (await invoke("mcp_set_json", {
					args: ["mcp", "set", name, "--json-stdin", "--json"],
					body: JSON.stringify(body),
				})) as unknown as McpSetResult;
			} else {
				const argv = buildArgvArgs(name, changed, spec);
				const hubResult = await runHubCmd(argv);
				result = parseCliJson<McpSetResult>(hubResult.output);
			}
			await invalidateRegistry();
			baseSpecRef.current = result.spec;
			hydratedKeyRef.current = `${name}:${JSON.stringify(result.spec)}`;
			setSpec(result.spec);
			setDirty(false);

			const priorSpec = result.prior_spec;
			toast.push({
				kind: "success",
				title: "Server updated",
				duration: UNDO_TOAST_DURATION_MS,
				action: {
					label: "Undo",
					onClick: () => {
						void (async () => {
							try {
								// m14: the WHOLE prior spec, always over stdin — transport,
								// command, args, url and headers undone together.
								await invoke("mcp_set_json", {
									args: ["mcp", "set", name, "--json-stdin", "--json"],
									body: JSON.stringify(priorSpec),
								});
								await invalidateRegistry();
							} catch (err) {
								toast.error("Couldn't undo", errText(err));
							}
						})();
					},
				},
			});
		} catch (err) {
			toast.error("Couldn't update the server", errText(err));
		} finally {
			setSaving(false);
		}
	}, [dirty, saving, spec, name, toast]);

	return {
		spec,
		original: baseSpecRef.current,
		dirty,
		saving,
		errors,
		saveDisabled,
		set,
		addHeader,
		removeHeader,
		addEnv,
		removeEnv,
		replaceWithRef,
		reset,
		save,
	};
}
