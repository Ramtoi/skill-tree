import { useEffect, useMemo, useRef, useState } from "react";
import { runHubCmd } from "@/lib/hubCmd";
import { errText } from "@/lib/hubWrite";
import { useNavigate } from "react-router-dom";
import { invalidateRegistryDerived } from "@/lib/invalidate";
import { invoke } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { useRegistry } from "@/hooks/useRegistry";
import {
  bareKeyOf,
  boundedDetail,
  literalSecretKeysOf,
  slugifyServerName,
  suggestRef,
  warningLine,
} from "@/lib/mcpContract";
import type { McpFailure, McpProbe, McpSpec } from "@/lib/mcpContract";
import { useToast } from "./Toast";
import { Button } from "./Button";
import { Field, MetaGrid } from "./Field";
import { DescriptionMeter, descriptionFieldClass } from "./DescriptionMeter";
import { Kbd } from "./Kbd";
import { ChipRadios } from "./ChipRadios";
import { Select, type SelectOption } from "./Select";
import { Plaque } from "./Plaque";
import { SCOPE_INTENT_NOTE, SCOPE_REACH, Tag, scopeKey } from "./Tag";
import {
  completeNewSkill,
  type AddToBundleTarget,
  type NewSkillCompletion,
} from "./newSkillCompletion";
import type { SkillType, SkillScope } from "@/types";
import { stopEvent } from "@/lib/pressable";

interface Props {
  open: boolean;
  onClose: () => void;
  /** m15/c-m chord: open straight into MCP · Add existing server, textarea
   *  focused (`/?new=1&mcp=paste`). Any other value is ignored. */
  initialMcpMode?: "paste";
  /** Bundle-local create flow. The entry is created first, then added through
   *  the bundle's own serialized membership queue. */
  addToBundle?: AddToBundleTarget;
}

// ─── MCP "add existing server" — pure helpers (no component state) ─────────
//
// The native shapes this reads/writes are the `claude mcp add-json` object
// (or its `{"mcpServers": {...}}` wrapper) — the exact bytes `hub mcp add
// --json-stdin` parses (`hub_cli/mcp.py::_parse_add_stdin`). `McpSpec`'s
// field names (`headers`/`env`/`url`) happen to line up with this shape, so
// `literalSecretKeysOf`/`suggestRef` (registry-shaped helpers) read it
// directly without a translation layer.

type McpAddSubMode = "paste" | "details";
type McpEquipTarget = "global" | "project";

interface McpAddDetails {
  transport: "stdio" | "http" | "sse";
  url: string;
  command: string;
  argsText: string;
  headerKey: string;
  headerValue: string;
}

interface McpAddDraft {
  subMode: McpAddSubMode;
  pastedText: string;
  /** The chosen key when the paste is a multi-key `mcpServers` wrapper. */
  whichKey: string | null;
  details: McpAddDetails;
  equipTarget: McpEquipTarget;
  equipProject: string;
  /** "Keep it anyway" was clicked — carries `--allow-literal` on submit. */
  allowLiteral: boolean;
}

const INITIAL_MCP_DETAILS: McpAddDetails = {
  transport: "http",
  url: "",
  command: "",
  argsText: "",
  headerKey: "Authorization",
  headerValue: "",
};

const INITIAL_MCP_DRAFT: McpAddDraft = {
  subMode: "paste",
  pastedText: "",
  whichKey: null,
  details: INITIAL_MCP_DETAILS,
  equipTarget: "global",
  equipProject: "",
  allowLiteral: false,
};

/** Verbatim `claude mcp add-json` example — the placeholder AND the visual
 *  anchor for "paste the block from the README". */
const PASTE_PLACEHOLDER =
  '{"type": "http", "url": "https://mcp.example.com/mcp", "headers": {"Authorization": "Bearer ${MY_TOKEN}"}}';

export function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Sorted keys of `obj.mcpServers`, or `null` when `obj` is not that wrapper
 *  shape (a bare server object, or unparseable). */
export function wrapperKeys(obj: Record<string, unknown> | null): string[] | null {
  const servers = obj?.mcpServers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    return Object.keys(servers as Record<string, unknown>).sort();
  }
  return null;
}

/** The parse-level half of `hub_cli.mcp._parse_add_stdin`'s read order
 *  (E3 rev 2 §2.1) that the SHEET can see without running `normalize_native`
 *  — BOM strip → `tryParseJsonObject` → at most one `mcpServers` unwrap
 *  (`empty_wrapper`/`nested_wrapper`) → the raw name to slugify. Exported
 *  for `mcpImportCorpus.test.ts` (the TS half of the shared import corpus,
 *  case 16) — a bare parse-level twin, not the full normaliser. */
export type ResolvedAddExistingName =
  | { ok: true; rawName: string }
  | {
      ok: false;
      reason: "empty_wrapper" | "nested_wrapper" | "invalid_json" | "no_name" | "unknown_candidate";
    };

/** C1: as strict as `hub_cli.mcp._parse_add_stdin` — a `nameArg` that names a
 *  wrapper but is NOT one of its keys is a refusal (`unknown_candidate`),
 *  never a silent fall-through to `keys[0]` when the wrapper happens to hold
 *  exactly one key. Python `_die`s on `name_arg not in servers` UNCONDITIONALLY,
 *  before it ever looks at how many keys the wrapper holds.
 *
 *  N6-new: a top-level `mcpServers` KEY that is PRESENT but not an object
 *  (`{"mcpServers": []}` / `{"mcpServers": "x"}`) is its own refusal in
 *  Python — `elif "mcpServers" in obj: _die("the mcpServers wrapper must be
 *  an object", code="invalid_json")` (`hub_cli/mcp.py:521-523`) — never a
 *  silent fall-through to treating the WHOLE pasted object as a bare server
 *  (which would register `nameArg` with `{"mcpServers": [...]}` itself as
 *  its spec). Checked BEFORE the bare-object fallback below. */
export function resolveAddExistingName(text: string, nameArg: string | null): ResolvedAddExistingName {
  const stripped = text.startsWith("﻿") ? text.slice(1) : text;
  const obj = tryParseJsonObject(stripped);
  if (!obj) return { ok: false, reason: "invalid_json" };
  const servers = obj.mcpServers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    const rec = servers as Record<string, unknown>;
    if ("mcpServers" in rec) return { ok: false, reason: "nested_wrapper" };
    const keys = Object.keys(rec);
    if (keys.length === 0) return { ok: false, reason: "empty_wrapper" };
    if (nameArg) {
      if (!keys.includes(nameArg)) return { ok: false, reason: "unknown_candidate" };
      return { ok: true, rawName: nameArg };
    }
    if (keys.length === 1) return { ok: true, rawName: keys[0] };
    return { ok: false, reason: "no_name" };
  }
  if ("mcpServers" in obj) return { ok: false, reason: "invalid_json" };
  if (nameArg) return { ok: true, rawName: nameArg };
  return { ok: false, reason: "no_name" };
}

/** The single server object this draft targets — unwrapping `mcpServers`
 *  when the paste is a wrapper, honoring `whichKey` when it names a real
 *  key. `null` only when the paste has not resolved to any object yet. */
export function serverObjectFor(
  obj: Record<string, unknown> | null,
  whichKey: string | null,
): Record<string, unknown> | null {
  if (!obj) return null;
  const keys = wrapperKeys(obj);
  if (keys) {
    if (keys.length === 0) return null;
    const key = whichKey && keys.includes(whichKey) ? whichKey : keys[0];
    const inner = (obj.mcpServers as Record<string, unknown>)[key];
    return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : null;
  }
  return obj;
}

/** Details-mode field values assembled into the same native shape a paste
 *  would carry (M8: one object, one submit path). */
/** One arg per LINE (E3 rev 2 §2.8) — never a `/\s+/` split, which would
 *  break an argument that itself contains a space (`/My Docs/x.py`) into two
 *  argv entries. */
function detailsToNative(d: McpAddDetails): Record<string, unknown> {
  const obj: Record<string, unknown> = { type: d.transport };
  if (d.transport === "stdio") {
    if (d.command.trim()) obj.command = d.command.trim();
    const args = d.argsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (args.length > 0) obj.args = args;
  } else if (d.url.trim()) {
    obj.url = d.url.trim();
  }
  if (d.headerKey.trim() && d.headerValue.trim()) {
    obj.headers = { [d.headerKey.trim()]: d.headerValue };
  }
  return obj;
}

/** One inline error under the paste textarea for a shape the sheet can see
 *  is wrong before it ever reaches the CLI (E3 rev 2 §2.8) — a top-level
 *  array, or plain invalid JSON. `""`/whitespace-only is not an error state
 *  (nothing pasted yet). */
function pastedJsonError(text: string): string | null {
  if (!text.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "That is not valid JSON.";
  }
  if (Array.isArray(parsed)) return "Paste a single server object, not a list.";
  if (parsed === null || typeof parsed !== "object") return "Paste a JSON object.";
  return null;
}

/** C3: `suggestRef`'s variable name must come from something real. When the
 *  Name field is still empty (paste → see the plaque → Replace, before the
 *  user has typed a name — the natural order the textarea's own autofocus
 *  invites), fall back to the endpoint host rather than the literal string
 *  `"server"` — `mcp.context7.com` → `context7`, dropping a generic leading
 *  label (`mcp`/`api`/`www`/`app`) and the trailing TLD-ish label. `null`
 *  when there is no usable URL (a bare stdio object with no name typed yet). */
function hostToVarPrefix(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const parts = new URL(url).hostname.split(".").filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    const withoutTld = parts.slice(0, -1);
    const GENERIC = new Set(["mcp", "api", "www", "app", "server"]);
    const meaningful = withoutTld.filter((p) => !GENERIC.has(p.toLowerCase()));
    return meaningful[0] || withoutTld[withoutTld.length - 1] || null;
  } catch {
    return null;
  }
}

function valueForLiteralKey(serverObj: Record<string, unknown>, key: string): string {
  const { bare, isQuery } = bareKeyOf(key);
  if (isQuery) {
    try {
      const u = new URL(String(serverObj.url ?? ""));
      return u.searchParams.get(bare) ?? "";
    } catch {
      return "";
    }
  }
  const headers = serverObj.headers as Record<string, string> | undefined;
  if (headers && bare in headers) return headers[bare];
  const env = serverObj.env as Record<string, string> | undefined;
  if (env && bare in env) return env[bare];
  return "";
}

function replaceValueInUrl(url: string, param: string, newValue: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(param, newValue);
    return u.toString();
  } catch {
    return url;
  }
}

interface McpAddResult {
  ok: true;
  name: string;
  created_dir: string;
  registered: boolean;
  equipped: { project: string } | null;
  spec: McpSpec;
  warnings: string[];
  probe: McpProbe | null;
}

/** m6: the toast's second line, naming the probe outcome. `undefined` for
 *  every other state — a bare "Server registered" carries no second line. */
function probeToastBody(probe: McpProbe | null): string | undefined {
  if (!probe) return undefined;
  if (probe.state === "ok") {
    const n = probe.tool_count ?? probe.tools.length;
    return `answered, ${n} tool${n === 1 ? "" : "s"}`;
  }
  if (probe.state === "unresolved_ref") {
    const names = probe.unresolved_refs.join(", ") || "A variable";
    const verb = probe.unresolved_refs.length === 1 ? "is" : "are";
    return `${names} ${verb} not set`;
  }
  return undefined;
}

export function NewSkillSheet({ open, onClose, initialMcpMode, addToBundle }: Props) {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: registry } = useRegistry();
  const [name, setName] = useState("");
  const [type, setType] = useState<SkillType>("claude-skill");
  const [scope, setScope] = useState<SkillScope>("global");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  // MCP path (D1): "Add existing server" first, always the default rung.
  const [mcpMode, setMcpMode] = useState<"add" | "scaffold">("add");
  const [draft, setDraft] = useState<McpAddDraft>(INITIAL_MCP_DRAFT);
  // The raw wrapper key the Name field was last DERIVED from (E3 rev 2 §2.8)
  // — `null` once the user has typed something of their own, or when the
  // paste carries no wrapper at all. Drives the `from "Sanity"` hint.
  const [derivedFromKey, setDerivedFromKey] = useState<string | null>(null);
  const pasteRef = useRef<HTMLTextAreaElement | null>(null);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Reset on open — including the MCP path (m15: a `?mcp=paste` open lands
  // straight on MCP · Add existing server).
  useEffect(() => {
    if (open) {
      setName("");
      setType(initialMcpMode ? "mcp-server" : "claude-skill");
      setScope("global");
      setDescription("");
      setLoading(false);
      setMcpMode("add");
      setDraft(INITIAL_MCP_DRAFT);
      setDerivedFromKey(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialMcpMode is read once per open, not tracked live.
  }, [open]);

  const addExisting = type === "mcp-server" && mcpMode === "add";

  // m7: autofocus the textarea whenever the sheet lands on MCP · Add existing
  // · Paste (initial open, a Type switch, or toggling back from Details) —
  // never the Name field's own `autoFocus`, which paste mode deliberately
  // does not want (m4/m7: the name usually arrives with the paste).
  useEffect(() => {
    if (addExisting && draft.subMode === "paste") {
      // eslint-disable-next-line no-restricted-syntax -- runs in a `useEffect` (already after commit); the paste textarea is already mounted in the SAME commit that switched `subMode`, the rAF only defers past the sheet's own reveal transition.
      const id = window.requestAnimationFrame(() => pasteRef.current?.focus());
      return () => window.cancelAnimationFrame(id);
    }
  }, [addExisting, draft.subMode]);

  const parsedPaste = useMemo(
    () => (draft.subMode === "paste" ? tryParseJsonObject(draft.pastedText) : null),
    [draft.subMode, draft.pastedText],
  );
  const wrapperKeyList = useMemo(() => wrapperKeys(parsedPaste), [parsedPaste]);
  // W4: a multi-key wrapper with nothing picked yet — the submit button's
  // own disabled state names this reason, and the picker shows an explicit
  // placeholder option instead of a blank, unlabelled well.
  const needsWhichKey =
    addExisting &&
    draft.subMode === "paste" &&
    !!wrapperKeyList &&
    wrapperKeyList.length > 1 &&
    !draft.whichKey;

  // m4/E3 rev 2 §2.8: prefill the Name field with `slugifyServerName(key)`
  // from a SINGLE-key wrapper only — a multi-key wrapper shows the picker
  // instead of silently choosing `keys[0]` (S05: the picker's own `onChange`
  // below is what fills Name once the user actually picks). Editable — a
  // non-empty Name is never overwritten, whether user-typed or already
  // derived. An unslugifiable key leaves the field empty (the `invalid_name`
  // line renders instead, further down).
  useEffect(() => {
    if (!addExisting || draft.subMode !== "paste") return;
    if (name.trim()) return;
    if (!wrapperKeyList || wrapperKeyList.length !== 1) return;
    const raw = wrapperKeyList[0];
    setName(slugifyServerName(raw) ?? "");
    setDerivedFromKey(raw);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `name` is read as a guard, not a trigger; re-running on every keystroke would fight the user's own edits.
  }, [addExisting, draft.subMode, wrapperKeyList]);

  const serverObj = useMemo(() => {
    if (!addExisting) return null;
    if (draft.subMode === "details") return detailsToNative(draft.details);
    return serverObjectFor(parsedPaste, draft.whichKey) ?? {};
  }, [addExisting, draft, parsedPaste]);

  const literalKeys = useMemo(
    () => (serverObj ? literalSecretKeysOf(serverObj as McpSpec) : []),
    [serverObj],
  );
  const literalRows = useMemo(() => {
    // C3: never derive from the literal string "server" — a real name, or
    // (before one is typed) the endpoint host, or nothing usable at all.
    const effectiveName = name.trim() || hostToVarPrefix(serverObj?.url) || "server";
    return literalKeys.map((key) => {
      const { bare, isQuery } = bareKeyOf(key);
      const value = serverObj ? valueForLiteralKey(serverObj, key) : "";
      const suggestion = suggestRef(effectiveName, bare, value);
      return { key, bare, isQuery, ...suggestion };
    });
  }, [literalKeys, serverObj, name]);
  const secretsBlocking = literalRows.length > 0 && !draft.allowLiteral;

  function handleReplace(row: (typeof literalRows)[number]) {
    if (draft.subMode === "details") {
      setDraft((d) => {
        if (row.isQuery) {
          return { ...d, details: { ...d.details, url: replaceValueInUrl(d.details.url, row.bare, row.value) } };
        }
        if (d.details.headerKey.trim() === row.bare) {
          return { ...d, details: { ...d.details, headerValue: row.value } };
        }
        return d;
      });
      return;
    }
    setDraft((d) => {
      if (!parsedPaste) return d;
      const cloned = JSON.parse(JSON.stringify(parsedPaste)) as Record<string, unknown>;
      const keys = wrapperKeys(cloned);
      const target = keys
        ? ((cloned.mcpServers as Record<string, Record<string, unknown>>)[
            d.whichKey && keys.includes(d.whichKey) ? d.whichKey : keys[0]
          ] ?? {})
        : cloned;
      if (row.isQuery) {
        target.url = replaceValueInUrl(String(target.url ?? ""), row.bare, row.value);
      } else if (target.headers && typeof target.headers === "object" && row.bare in (target.headers as object)) {
        (target.headers as Record<string, string>)[row.bare] = row.value;
      } else if (target.env && typeof target.env === "object" && row.bare in (target.env as object)) {
        (target.env as Record<string, string>)[row.bare] = row.value;
      }
      return { ...d, pastedText: JSON.stringify(cloned, null, 2) };
    });
  }

  async function finishCreation(result: NewSkillCompletion) {
    await completeNewSkill({ ...result, addToBundle, toast, onClose, navigate });
  }

  async function submitAddExisting() {
    const trimmed = name.trim();
    if (!trimmed || secretsBlocking || stdioMissingCommand || !!pasteError) return;
    // W4: a multi-key wrapper with nothing picked yet is a distinct disabled
    // state (guarded below too, defensively — the submit button is already
    // disabled+`disabledReason`'d for this).
    if (needsWhichKey) return;
    setLoading(true);
    try {
      const bodyText =
        draft.subMode === "paste" ? draft.pastedText : JSON.stringify(detailsToNative(draft.details));
      const scopeArg = draft.equipTarget === "project" ? "project-specific" : "global";
      // C1: `hub mcp add`'s positional name is a WRAPPER LOOKUP KEY, not a
      // slug — `_parse_add_stdin` refuses anything else when the paste
      // carries an `mcpServers` wrapper (`'<name>' is not a key in
      // mcpServers: ...`). The typed/derived Name field only ever supplies
      // the registered name for a BARE (non-wrapper) paste or a details-mode
      // submit; for a wrapper paste it is cosmetic display only (the
      // `from "<key>"` hint) — the CLI derives and slugifies the real
      // registered name itself, echoed back in `payload.name`/`warnings`.
      const positionalName =
        draft.subMode === "paste" && wrapperKeyList
          ? (wrapperKeyList.length === 1 ? wrapperKeyList[0] : (draft.whichKey ?? ""))
          : trimmed;
      const args = ["mcp", "add", positionalName, "--scope", scopeArg];
      if (draft.equipTarget === "project" && draft.equipProject) {
        args.push("--project", draft.equipProject);
      }
      if (draft.allowLiteral) args.push("--allow-literal");
      args.push("--json-stdin", "--probe", "--json");
      const payload = await invoke<McpAddResult | McpFailure>("mcp_add_json", { args, body: bodyText });
      if (payload.ok === false) {
        toast.error("Couldn't add the server", `${payload.error} Nothing was changed.`);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: qk.registry() });
      void invalidateRegistryDerived();
      // The registered name can differ from what was typed (a non-slug name
      // typed by hand, or a bare-object paste with no wrapper) — navigate to
      // and probe-cache the REGISTERED name, never `trimmed` (E3 rev 2 §2.8).
      if (payload.probe) queryClient.setQueryData(qk.mcpProbe(payload.name), payload.probe);
      const renamedFromWarning = payload.warnings.find((w) => w.startsWith("renamed_from:"));
      const title = renamedFromWarning
        ? `Adopted ${renamedFromWarning.slice("renamed_from:".length)} as ${payload.name}.`
        : "Server registered";
      // (E3 rev 2 §2.8) `payload.warnings` render in the result BEFORE the
      // probe outcome line.
      const bodyParts = [
        ...payload.warnings
          .filter((w) => !w.startsWith("renamed_from:"))
          .map((w) => warningLine(w, payload.name)),
        probeToastBody(payload.probe),
      ].filter((x): x is string => Boolean(x));
      await finishCreation({
        createdName: payload.name,
        standaloneTitle: title,
        bundleVerb: "Registered",
        body: bodyParts.length > 0 ? bodyParts.join(" ") : undefined,
        focusMcp: true,
      });
    } catch (err) {
      toast.error("Couldn't add the server", errText(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (addExisting) {
      await submitAddExisting();
      return;
    }
    if (!name.trim()) return;
    setLoading(true);
    try {
      const kind = type === "mcp-server" ? "mcp" : "skill";
      await runHubCmd([
        "new",
        kind,
        name.trim(),
        "--type",
        type,
        "--scope",
        scope,
        "--description",
        description.trim(),
      ]);
      await queryClient.invalidateQueries({ queryKey: qk.registry() });
      void invalidateRegistryDerived();
      const createdName = name.trim();
      await finishCreation({
        createdName,
        standaloneTitle: `Skill "${createdName}" created`,
        bundleVerb: "Created",
        focusMcp: type === "mcp-server",
      });
    } catch (err) {
      toast.error("Couldn't create skill", errText(err));
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  const projectOptions: SelectOption<string>[] = Object.keys(registry?.projects ?? {}).map((p) => ({
    value: p,
    label: p,
  }));
  // E3 rev 2 §2.8: the Name field's derived-value state — a hint naming the
  // raw wrapper key when it differs from the (slugified) Name, or an
  // `invalid_name` error when that key could not become a slug at all.
  const invalidWrapperKey =
    addExisting && draft.subMode === "paste" && derivedFromKey !== null && !name.trim()
      ? derivedFromKey
      : null;
  // N10: the identifier itself renders in mono — the design language's rule
  // for any proper-noun identifier. W5: the raw key is stdin-controlled and
  // never interpolated into the DOM unbounded.
  const nameFromPasteHint =
    !invalidWrapperKey && derivedFromKey && derivedFromKey !== name ? (
      <>
        from "<code style={{ fontFamily: "var(--font-mono)" }}>{boundedDetail(derivedFromKey)}</code>"
      </>
    ) : undefined;
  // W10: a wrapper paste's positional name is ALWAYS the raw wrapper key
  // (`submitAddExisting`'s `positionalName`, never `trimmed`) — the CLI, not
  // this field, decides the slug. Editing the Name here used to be silently
  // discarded on submit; the field is now read-only for the whole life of a
  // wrapper paste (single-key or multi-key alike) so there is nothing to
  // discard, and the hint says why instead of implying the edit "took".
  const nameReadOnlyForWrapper = addExisting && draft.subMode === "paste" && !!wrapperKeyList;
  const nameHint = nameReadOnlyForWrapper ? (
    <>
      <span style={{ display: "block" }}>Name comes from the pasted key.</span>
      {nameFromPasteHint && <span style={{ display: "block" }}>{nameFromPasteHint}</span>}
    </>
  ) : (
    nameFromPasteHint
  );
  const pasteError = draft.subMode === "paste" ? pastedJsonError(draft.pastedText) : null;
  const submitLabel = addToBundle
    ? addExisting
      ? "Add server to bundle"
      : "Create and add"
    : addExisting
      ? "Add server"
      : mcpMode === "scaffold" && type === "mcp-server"
        ? "Create server"
        : "Create skill";
  const submitLoadingLabel = addExisting ? "Adding…" : "Creating…";
  // E3 rev 2 §2.8: a stdio server needs a real command — no silent `python3`
  // default for something the sheet is creating from scratch.
  const stdioMissingCommand =
    addExisting &&
    draft.subMode === "details" &&
    draft.details.transport === "stdio" &&
    !draft.details.command.trim();
  const submitDisabled =
    loading ||
    !name.trim() ||
    (addExisting && (secretsBlocking || stdioMissingCommand || !!pasteError || needsWhichKey));
  const submitDisabledReason = needsWhichKey ? "Pick which server to add first." : undefined;

  return (
    <div className="palette-backdrop" role="presentation" onClick={onClose}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- onClick only stops the backdrop's close-on-click from firing for clicks inside the dialog; role="dialog" already carries the real interaction semantics. */}
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="New skill"
        onClick={stopEvent}
        style={{ width: "min(480px, 92vw)", maxHeight: "min(86vh, 760px)" }}
      >
        <div className="palette-head">
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-strong)" }}>
            New skill
          </span>
          {addToBundle && (
            <Tag className="tag-sentence" size="sm" color="var(--fg-mute)">
              add to <span className="text-mono">{addToBundle.name}</span>
            </Tag>
          )}
          <span style={{ marginLeft: "auto" }}>
            <Kbd>esc</Kbd>
          </span>
        </div>
        {/* C2: the MCP path grew this form well past what fits in one screen
            (Name/Type + two ChipRadios rows + an 8-row textarea + the amber
            Plaque + the equip row) — the body scrolls in its own region and
            the Cancel/submit row stays pinned below it, never clipped. */}
        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
        >
          <div
            style={{
              padding: 18,
              display: "flex",
              flexDirection: "column",
              gap: 14,
              overflowY: "auto",
              minHeight: 0,
            }}
          >
          <MetaGrid>
            <Field
              label="name"
              full
              hint={nameHint}
              error={
                invalidWrapperKey
                  ? `${boundedDetail(invalidWrapperKey)} cannot become a skill name even after lowercasing.`
                  : undefined
              }
            >
              <input
                autoFocus={!initialMcpMode}
                value={name}
                readOnly={nameReadOnlyForWrapper}
                aria-readonly={nameReadOnlyForWrapper || undefined}
                onChange={(e) => {
                  // W10: a wrapper paste's Name is derived, not typed — an
                  // edit here (even a programmatic one) is a no-op, not a
                  // silently-discarded value the CLI will never see.
                  if (nameReadOnlyForWrapper) return;
                  setName(e.target.value);
                  setDerivedFromKey(null);
                }}
                placeholder="my-skill-name"
                pattern="[a-z0-9\-]+"
                required
                style={
                  nameReadOnlyForWrapper ? { background: "var(--bg-2)", cursor: "default" } : undefined
                }
              />
            </Field>
            <Field label="type">
              <select value={type} onChange={(e) => setType(e.target.value as SkillType)}>
                <option value="claude-skill">SKILL</option>
                <option value="mcp-server">MCP</option>
              </select>
            </Field>
          </MetaGrid>

          {type === "mcp-server" && (
            <ChipRadios
              name="mcp-add-mode"
              label="How"
              value={mcpMode}
              onChange={setMcpMode}
              options={[
                { value: "add", label: "Add existing server" },
                { value: "scaffold", label: "Scaffold a new server" },
              ]}
            />
          )}

          {addExisting ? (
            <>
              <ChipRadios
                name="mcp-add-submode"
                label="Server source"
                value={draft.subMode}
                onChange={(v) => setDraft((d) => ({ ...d, subMode: v }))}
                options={[
                  { value: "paste", label: "Paste server JSON" },
                  { value: "details", label: "Enter details" },
                ]}
              />
              {draft.subMode === "paste" ? (
                <Field
                  label="server JSON"
                  full
                  hint="Paste the block from the server's README. The mcpServers wrapper is fine too."
                  error={pasteError ?? undefined}
                >
                  <textarea
                    ref={pasteRef}
                    value={draft.pastedText}
                    onChange={(e) => setDraft((d) => ({ ...d, pastedText: e.target.value }))}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void submitAddExisting();
                      }
                    }}
                    placeholder={PASTE_PLACEHOLDER}
                    rows={8}
                    style={{ fontFamily: "var(--font-mono)" }}
                  />
                </Field>
              ) : (
                <>
                  <ChipRadios
                    name="mcp-add-transport"
                    label="Transport"
                    value={draft.details.transport}
                    onChange={(v) =>
                      setDraft((d) => ({ ...d, details: { ...d.details, transport: v } }))
                    }
                    options={[
                      { value: "stdio", label: "Local (stdio)" },
                      { value: "http", label: "Remote (HTTP)" },
                      { value: "sse", label: "SSE (deprecated)" },
                    ]}
                  />
                  {draft.details.transport === "stdio" ? (
                    <MetaGrid>
                      <Field
                        label="command"
                        hint="Required for a local (stdio) server — hub never defaults one."
                      >
                        <input
                          value={draft.details.command}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, details: { ...d.details, command: e.target.value } }))
                          }
                          placeholder="npx"
                        />
                      </Field>
                      <Field label="arguments" hint="One per line.">
                        <textarea
                          value={draft.details.argsText}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, details: { ...d.details, argsText: e.target.value } }))
                          }
                          placeholder={"-y\n@scope/pkg"}
                          rows={3}
                          style={{ fontFamily: "var(--font-mono)" }}
                        />
                      </Field>
                    </MetaGrid>
                  ) : (
                    <Field label="URL" full>
                      <input
                        value={draft.details.url}
                        onChange={(e) => setDraft((d) => ({ ...d, details: { ...d.details, url: e.target.value } }))}
                        placeholder="https://mcp.example.com/mcp"
                      />
                    </Field>
                  )}
                  <MetaGrid>
                    <Field label="header key">
                      <input
                        value={draft.details.headerKey}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, details: { ...d.details, headerKey: e.target.value } }))
                        }
                        placeholder="Authorization"
                      />
                    </Field>
                    <Field label="header value">
                      <input
                        value={draft.details.headerValue}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, details: { ...d.details, headerValue: e.target.value } }))
                        }
                        placeholder="Bearer ${MY_TOKEN}"
                      />
                    </Field>
                  </MetaGrid>
                </>
              )}

              {wrapperKeyList && wrapperKeyList.length > 1 && (
                <Select
                  label="Which server?"
                  // E3 rev 2 §2.8: no key is chosen yet ("prefills nothing")
                  // — falling back to `wrapperKeyList[0]` here would make
                  // `Select` treat that key as already selected and skip
                  // `onChange` on a first click that matches it (its own
                  // change-only dispatch, `Select.tsx:109`).
                  value={draft.whichKey ?? ""}
                  onChange={(v) => {
                    setDraft((d) => ({ ...d, whichKey: v }));
                    // C1: the picker must drive what actually gets submitted
                    // (`name` is the positional arg `hub mcp add` uses to
                    // pick the wrapper member) — but only when the current
                    // Name is still a DERIVED value (empty, or the last thing
                    // this picker itself derived), never a name the user
                    // typed. E3 rev 2 §2.8: the field takes the SLUG, not the
                    // raw key.
                    if (!name.trim() || derivedFromKey !== null) {
                      setName(slugifyServerName(v) ?? "");
                      setDerivedFromKey(v);
                    }
                  }}
                  // W4: an explicit placeholder OPTION (not a fallback to
                  // `wrapperKeyList[0]`, which `Select` would then treat as
                  // already selected) — without it the trigger rendered a
                  // blank, unlabelled well (`value=""` matches nothing in
                  // `options`) instead of a legible prompt.
                  options={[
                    { value: "", label: "Pick which server to add" },
                    ...wrapperKeyList.map((k) => ({ value: k, label: k })),
                  ]}
                />
              )}

              {literalRows.length > 0 && (
                <Plaque
                  eyebrow="A token is written in plain text"
                  // S5: once acknowledged, the remaining amber in the sheet
                  // should still mean "unresolved" — `Plaque` has no
                  // "neutral" accent of its own (only anchor/amber/red), so
                  // this drops to the anchor register, the least alarming
                  // option that still exists.
                  accent={draft.allowLiteral ? "anchor" : "amber"}
                  actions={
                    !draft.allowLiteral ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDraft((d) => ({ ...d, allowLiteral: true }))}
                      >
                        Keep it anyway
                      </Button>
                    ) : undefined
                  }
                >
                  {literalRows.map((row) => (
                    <p key={row.key} style={{ margin: "4px 0", fontSize: 12 }}>
                      <code>{row.bare}</code> carries a literal value. It would be copied into every
                      harness config file, and Skill Tree would exclude it from backups.{" "}
                      <Button variant="primary" size="sm" onClick={() => handleReplace(row)}>
                        {`Replace with \${${row.varName}}`}
                      </Button>
                    </p>
                  ))}
                  {draft.allowLiteral && (
                    <p className="text-dim" style={{ fontSize: 11.5 }}>
                      Kept as written — excluded from backups.
                    </p>
                  )}
                </Plaque>
              )}

              <ChipRadios
                name="mcp-add-equip"
                label="Equip"
                value={draft.equipTarget}
                onChange={(v) => setDraft((d) => ({ ...d, equipTarget: v }))}
                options={[
                  { value: "global", label: "Everywhere (global)" },
                  { value: "project", label: "One project…" },
                ]}
              />
              {draft.equipTarget === "project" && (
                <Select
                  label="Project"
                  value={draft.equipProject}
                  onChange={(v) => setDraft((d) => ({ ...d, equipProject: v }))}
                  options={projectOptions}
                />
              )}
            </>
          ) : (
            <MetaGrid>
              <Field
                label="scope"
                full
                hint={
                  <>
                    {SCOPE_REACH[scopeKey(scope)]}
                    {scopeKey(scope) !== "global" && ` · ${SCOPE_INTENT_NOTE}`}
                  </>
                }
              >
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as SkillScope)}
                >
                  <option value="global" title={SCOPE_REACH.global}>
                    global — {SCOPE_REACH.global}
                  </option>
                  <option value="portable" title={SCOPE_REACH.portable}>
                    portable — {SCOPE_REACH.portable}
                  </option>
                  <option value="project-specific" title={SCOPE_REACH.project}>
                    project-specific — {SCOPE_REACH.project}
                  </option>
                </select>
              </Field>
              <Field
                label="description"
                full
                className={descriptionFieldClass(description)}
                hint={<DescriptionMeter value={description} />}
              >
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="One-line description…"
                  rows={2}
                />
              </Field>
            </MetaGrid>
          )}
          </div>

          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              padding: "12px 18px",
              borderTop: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <Button onClick={onClose} type="button">
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="check"
              type="submit"
              disabled={submitDisabled}
              disabledReason={submitDisabledReason}
              busy={loading}
            >
              {loading ? submitLoadingLabel : submitLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
