import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { useRegistry } from "@/hooks/useRegistry";
import { useAppStore } from "@/store";
import { useRunSync } from "@/hooks/useRunSync";
import { useUndoableAction } from "@/hooks/useUndoableAction";
import { useHookList } from "@/hooks/useHooks";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { hintForBindingId } from "@/lib/keymap";
import { CLOUD_TARGET_CATALOG } from "@/lib/cloud";
import {
  PALETTE_VERBS,
  SLUG_RE,
  type PaletteConfirm,
  type PaletteOption,
  type PaletteVerb,
} from "@/lib/paletteVerbs";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";
import { ConfirmDialog } from "./Modal";
import { stopEvent } from "@/lib/pressable";
import { PALETTE_LIBRARY_SEARCH_FOCUS } from "@/lib/librarySearchHandoff";

type ItemKind = "action" | "project" | "bundle" | "skill";

interface PaletteItem {
  kind: ItemKind;
  id: string;
  name: string;
  icon: string;
  hint: string;
  /** Present on verb entries — selecting pushes an argument stage. */
  verb?: PaletteVerb;
  /** Present on plain entries — selecting runs then closes. */
  exec?: () => void;
}

interface IndexedPaletteItem extends PaletteItem {
  _idx: number;
}

/** Root-stage list caps: how many items render before "+N more" kicks in.
 *  Destinations are pushed ahead of projects/bundles/skills, so the no-query cap
 *  is sized to leave room for every group: it grew by 2 when the two cloud-app
 *  destinations landed, and by 1 more when "Add MCP server…" (m15) landed,
 *  rather than silently pushing a skill off the end. */
const ROOT_CAP_NO_QUERY = 27;
const ROOT_CAP_QUERY = 31;

const GROUP_ORDER: ItemKind[] = ["action", "project", "bundle", "skill"];
const GROUP_TITLES: Record<ItemKind, string> = {
  action: "Actions",
  project: "Projects",
  bundle: "Bundles",
  skill: "Skills",
};

export function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const closePalette = useAppStore((s) => s.closePalette);
  const initialVerb = useAppStore((s) => s.paletteInitialVerb);
  const clearInitialVerb = useAppStore((s) => s.clearPaletteInitialVerb);
  const openTips = useAppStore((s) => s.openTips);
  const openSettings = useAppStore((s) => s.openSettings);

  const { data: registry } = useRegistry();
  const { data: hookData } = useHookList();
  const harnesses = useAppStore((s) => s.harnesses);
  const navigate = useNavigate();
  const runSync = useRunSync();
  const runUndoable = useUndoableAction();

  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  // Stage machine: verb === null ⇒ root stage; otherwise the verb's argIndex.
  const [verb, setVerb] = useState<PaletteVerb | null>(null);
  const [argIndex, setArgIndex] = useState(0);
  const [picked, setPicked] = useState<Record<string, string>>({});
  // A pending consequence confirm (e.g. a global hook attach). Rendered OUTSIDE
  // the palette body so it survives the palette closing beneath it.
  const [pendingConfirm, setPendingConfirm] = useState<PaletteConfirm | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => {
    closePalette();
  }, [closePalette]);

  // Verb `confirm` hook: park the consequence, close the list, let the dialog
  // (below, independent of `open`) drive the actual commit.
  const confirm = useCallback(
    (opts: PaletteConfirm) => {
      setPendingConfirm(opts);
      close();
    },
    [close],
  );

  const handleSync = useCallback(() => {
    void runSync();
  }, [runSync]);

  const enterVerb = useCallback((v: PaletteVerb) => {
    setVerb(v);
    setArgIndex(0);
    setPicked({});
    setQ("");
    setActive(0);
  }, []);

  // Reset state and focus when the palette opens (jump into a verb if requested).
  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    const v = initialVerb
      ? PALETTE_VERBS.find((x) => x.id === initialVerb) ?? null
      : null;
    setVerb(v);
    setArgIndex(0);
    setPicked({});
    if (initialVerb) clearInitialVerb();
    // eslint-disable-next-line no-restricted-syntax -- runs in a `useEffect` (already after commit); `inputRef.current` is already mounted here, the rAF only defers past the palette's own open transition.
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open, initialVerb, clearInitialVerb]);

  // Reset active row whenever the query changes.
  useEffect(() => {
    setActive(0);
  }, [q]);

  const currentArg = verb ? verb.args[argIndex] : null;

  // Advance the verb flow: record the pick, then step to the next arg or run.
  const advance = useCallback(
    (value: string) => {
      if (!verb || !currentArg) return;
      const nextPicked = { ...picked, [currentArg.name]: value };
      if (argIndex + 1 < verb.args.length) {
        setPicked(nextPicked);
        setArgIndex((i) => i + 1);
        setQ("");
        setActive(0);
      } else {
        // Terminal action.
        void verb.run(nextPicked, { navigate, runUndoable, confirm });
        close();
      }
    },
    [verb, currentArg, picked, argIndex, navigate, runUndoable, confirm, close],
  );

  // Esc pops exactly one stage (clearing a non-empty search first).
  const popStage = useCallback(() => {
    if (q) {
      setQ("");
      return;
    }
    if (verb) {
      if (argIndex > 0) {
        setPicked((p) => {
          const n = { ...p };
          delete n[verb.args[argIndex - 1].name];
          return n;
        });
        setArgIndex((i) => i - 1);
        setActive(0);
      } else {
        setVerb(null);
        setPicked({});
        setActive(0);
      }
      return;
    }
    close();
  }, [q, verb, argIndex, close]);

  // ── Root items (destinations + verbs), each carrying its true registry hint ──
  const rootItems = useMemo<PaletteItem[]>(() => {
    const all: PaletteItem[] = [];
    const action = (
      id: string,
      name: string,
      icon: string,
      opts: { bindingId?: string; verb?: PaletteVerb; exec?: () => void },
    ) =>
      all.push({
        kind: "action",
        id,
        name,
        icon,
        hint: opts.bindingId ? hintForBindingId(opts.bindingId) : "",
        verb: opts.verb,
        exec: opts.exec,
      });

    // Verbs (argument-taking) first — the new command layer.
    for (const v of PALETTE_VERBS) action(v.id, v.label, v.icon, { verb: v });

    action("new-skill", "New skill", "plus", {
      bindingId: "create.skill",
      exec: () => navigate("/?new=1"),
    });
    action("new-bundle", "New bundle", "bundle", {
      bindingId: "create.bundle",
      exec: () => navigate("/?addBundle=1"),
    });
    // m15: a zero-argument entry (opens the New sheet already on MCP · Add
    // existing server) — the same plain-action pattern as "New skill"/"Add
    // project" above, not a `PaletteVerb` (that machinery only fires `run`
    // once an argument stage is picked; a verb with no args never advances).
    action("add-mcp-server", "Add MCP server…", "mcp", {
      bindingId: "create.mcp",
      exec: () => navigate("/?new=1&mcp=paste"),
    });
    action("add-project", "Add project", "project", {
      exec: () => navigate("/?addProject=1"),
    });
    action("tips", "Show tips tour", "spark", { exec: () => openTips() });
    action("settings", "Open Settings", "cog", {
      exec: () => openSettings(),
    });
    action("sync", "Sync registry to agent folders", "sync", { exec: handleSync });
    action("lib", "Open library", "library", {
      bindingId: "nav.library",
      exec: () => navigate("/"),
    });
    action("harnesses", "Open harnesses", "harness", {
      bindingId: "nav.harnesses",
      exec: () => navigate("/harnesses"),
    });
    action("snippets", "Open snippets", "snippet", {
      bindingId: "nav.snippets",
      exec: () => navigate("/snippets"),
    });
    action("permissions", "Open permissions", "permissions", {
      bindingId: "nav.permissions",
      exec: () => navigate("/permissions"),
    });
    action("sources", "Open sources", "source", {
      bindingId: "nav.sources",
      exec: () => navigate("/sources"),
    });
    action("remotes", "Open remotes", "remote", {
      bindingId: "nav.remotes",
      exec: () => navigate("/remotes"),
    });
    // Cloud apps: the catalog is fixed in code backend-side, so mirroring it
    // costs no query — injecting these from `hub cloud targets` would fire a
    // subprocess at app boot for a destination reached once in a while.
    CLOUD_TARGET_CATALOG.forEach((t) => {
      action(`cloud-${t.id}`, `Open ${t.label} skills`, "globe", {
        exec: () => navigate(`/cloud/${encodeURIComponent(t.id)}`),
      });
    });
    action("usage", "Open local agent usage", "usage", {
      bindingId: "nav.usage",
      exec: () => navigate("/usage"),
    });
    action("backup", "Open backup", "source", {
      bindingId: "nav.backup",
      exec: () => navigate("/backup"),
    });
    // "Back up now" routes to the screen rather than firing the snapshot blind
    // from the palette: the action is one-way (a pushed snapshot has no undo),
    // so the user lands where the result and its warnings show.
    //
    // The request rides in the navigation STATE, not in the URL. A `?now=1`
    // param survives a reload and would re-fire the push unattended; navigation
    // state is consumed and cleared by the screen. Invoking this again while
    // already on /backup mints a new location key, which is what re-triggers it.
    action("backup-now", "Back up now", "sync", {
      exec: () => navigate("/backup", { state: { backupNow: true } }),
    });
    harnesses
      .filter((h) => h.installed)
      .forEach((h) => {
        action(`harness-${h.id}`, `Configure ${h.label}`, "harness", {
          exec: () => navigate(`/harness/${encodeURIComponent(h.id)}`),
        });
      });

    if (registry) {
      Object.entries(registry.projects ?? {}).forEach(([name, p]) => {
        all.push({
          kind: "project",
          id: `p-${name}`,
          name,
          icon: "project",
          hint: `${resolveActiveSkills(p, registry).length} equipped`,
          exec: () => navigate(`/project/${encodeURIComponent(name)}`),
        });
      });
      Object.entries(registry.bundles ?? {}).forEach(([name, b]) => {
        all.push({
          kind: "bundle",
          id: `b-${name}`,
          name,
          icon: "bundle",
          hint: `${b.skills.length} skills`,
          exec: () => navigate(`/bundle/${encodeURIComponent(name)}`),
        });
      });
      Object.entries(registry.skills ?? {}).forEach(([name, s]) => {
        all.push({
          kind: "skill",
          id: `s-${name}`,
          name,
          icon: s.type === "mcp-server" ? "mcp" : "skill",
          hint: s.scope,
          exec: () => navigate(`/skill/${encodeURIComponent(name)}`),
        });
      });
    }
    return all;
  }, [registry, harnesses, navigate, handleSync, openTips, openSettings]);

  // ── Argument-stage list options (for kind:"list") ──
  const argOptions = useMemo<PaletteOption[]>(() => {
    if (!verb || !currentArg || currentArg.kind !== "list" || !registry) return [];
    return currentArg.options?.(picked, { registry, hooks: hookData?.hooks }) ?? [];
  }, [verb, currentArg, picked, registry, hookData]);

  // The navigable items for the current stage (root list OR arg-list options).
  const items = useMemo<PaletteItem[]>(() => {
    const lq = q.trim().toLowerCase();
    if (verb && currentArg?.kind === "list") {
      const opts = lq
        ? argOptions.filter((o) => o.name.toLowerCase().includes(lq))
        : argOptions;
      return opts.map((o) => ({
        kind: "action" as const,
        id: o.id,
        name: o.name,
        icon: o.icon ?? "dot",
        hint: o.hint ?? "",
        exec: () => advance(o.id),
      }));
    }
    // The Library handoff belongs only to the root stage. In particular, a
    // text argument is validated by its verb rather than treated as search.
    if (verb) return [];
    // Root stage.
    if (!lq) return rootItems.slice(0, ROOT_CAP_NO_QUERY);
    const matches = rootItems
      .filter((x) => x.name.toLowerCase().includes(lq))
      .slice(0, ROOT_CAP_QUERY);
    if (matches.length > 0) return matches;
    return [{
      kind: "action",
      id: "search-library",
      name: `Search Library for \u201c${q}\u201d`,
      icon: "search",
      hint: "",
      exec: () => {
        const params = new URLSearchParams({ q });
        navigate(
          { pathname: "/", search: `?${params.toString()}` },
          { state: { [PALETTE_LIBRARY_SEARCH_FOCUS]: true } },
        );
      },
    }];
  }, [q, verb, currentArg, argOptions, rootItems, advance, navigate]);

  // How many root items were cut past the cap — drives a non-interactive
  // "+N more" affordance so a silently-truncated list can't read as complete
  // (B1-07). Only the root stage truncates; arg-list stages don't.
  const rootOverflow = useMemo(() => {
    if (verb && currentArg?.kind === "list") return 0;
    const lq = q.trim().toLowerCase();
    const total = lq
      ? rootItems.filter((x) => x.name.toLowerCase().includes(lq)).length
      : rootItems.length;
    const cap = lq ? ROOT_CAP_QUERY : ROOT_CAP_NO_QUERY;
    return Math.max(0, total - cap);
  }, [q, verb, currentArg, rootItems]);

  const groups = useMemo(() => {
    const out: Partial<Record<ItemKind, IndexedPaletteItem[]>> = {};
    items.forEach((it, idx) => {
      const bucket = out[it.kind] ?? (out[it.kind] = []);
      bucket.push({ ...it, _idx: idx });
    });
    return out;
  }, [items]);

  const selectItem = useCallback(
    (it: PaletteItem) => {
      if (it.verb) {
        enterVerb(it.verb);
        return;
      }
      it.exec?.();
      if (!(verb && currentArg?.kind === "list")) close();
      // For an arg-list, `advance` already handles close/step; exec is advance.
    },
    [enterVerb, verb, currentArg, close],
  );

  // Text-argument submit (validated slug).
  const textValue = q;
  const textValid = currentArg?.kind === "text" ? SLUG_RE.test(textValue.trim()) : false;

  function handleKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (currentArg?.kind === "text") {
        if (textValid) advance(textValue.trim());
        return;
      }
      const it = items[active];
      if (it) selectItem(it);
    } else if (e.key === "Escape") {
      e.preventDefault();
      popStage();
    }
  }

  // Breadcrumb: verb label › already-picked args › current stage title.
  const crumbs: string[] = [];
  if (verb) {
    crumbs.push(verb.label.replace(/…$/, ""));
    for (let i = 0; i < argIndex; i++) {
      const v = picked[verb.args[i].name];
      if (v) crumbs.push(v);
    }
    if (currentArg) crumbs.push(currentArg.title);
  }

  return (
    <>
      {open && (
      <div className="palette-backdrop" role="presentation" onClick={close}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- onClick only stops the backdrop's close-on-click from firing for clicks inside the dialog; role="dialog" already carries the real interaction semantics (Escape via handleKey above). */}
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={stopEvent}
      >
        {verb && (
          <div className="palette-crumbs" aria-label="Command breadcrumb">
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="palette-crumb-sep">›</span>}
                <span className="palette-crumb">{c}</span>
              </Fragment>
            ))}
          </div>
        )}
        <div className="palette-head">
          <Icon name="command" size={16} style={{ color: "var(--anchor-2)" }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={handleKey}
            aria-controls="palette-listbox"
            aria-activedescendant={
              items[active] ? `palette-opt-${items[active].id}` : undefined
            }
            placeholder={
              currentArg
                ? currentArg.placeholder ?? `${currentArg.title}…`
                : "Jump to skill, project, bundle, or action…"
            }
          />
          <Kbd>esc</Kbd>
        </div>

        {currentArg?.kind === "text" ? (
          <div className="palette-text-stage">
            <div className="palette-text-hint">
              {textValue.trim() === "" ? (
                <span className="text-dim">Enter a lowercase slug (a–z, 0–9, -).</span>
              ) : textValid ? (
                <span className="text-ok">
                  <Icon name="check" size={12} /> Press <Kbd>↵</Kbd> to continue
                </span>
              ) : (
                <span className="text-warn">
                  <Icon name="warning" size={12} /> Not a valid slug.
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="palette-list" id="palette-listbox" role="listbox">
            {GROUP_ORDER.map((g) => {
              const groupItems = groups[g];
              if (!groupItems || groupItems.length === 0) return null;
              return (
                <Fragment key={g}>
                  <div className="palette-section">
                    {verb && currentArg
                      ? currentArg.title
                      : `${GROUP_TITLES[g]} · ${groupItems.length}`}
                  </div>
                  {groupItems.map((it) => (
                    // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- composite listbox option (aria-selected + owning input's onKeyDown/aria-activedescendant, the EquipPicker.tsx pattern); the option itself is never a separate tab stop.
                    <div
                      key={it.id}
                      id={`palette-opt-${it.id}`}
                      role="option"
                      aria-selected={it._idx === active}
                      className="palette-item"
                      data-active={it._idx === active}
                      onMouseEnter={() => setActive(it._idx)}
                      onClick={() => selectItem(it)}
                    >
                      <Icon
                        name={it.icon}
                        size={14}
                        style={{ color: "var(--fg-mute)" }}
                      />
                      <span className="name">{it.name}</span>
                      <span className="hint">{it.hint}</span>
                    </div>
                  ))}
                </Fragment>
              );
            })}
            {rootOverflow > 0 && (
              <div
                className="palette-more"
                aria-hidden="true"
                style={{
                  padding: "8px 12px",
                  color: "var(--fg-mute)",
                  fontSize: 12,
                }}
              >
                +{rootOverflow} more — keep typing to narrow
              </div>
            )}
            {items.length === 0 && (
              <div
                style={{
                  padding: "24px 12px",
                  textAlign: "center",
                  color: "var(--fg-mute)",
                  fontSize: 12,
                }}
              >
                No matches for "{q}"
              </div>
            )}
          </div>
        )}

        <div className="palette-foot">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>esc</Kbd> {verb ? "back" : "dismiss"}
          </span>
          <span style={{ marginLeft: "auto" }}>⌘K from anywhere</span>
        </div>
      </div>
    </div>
      )}
      {pendingConfirm && (
        <ConfirmDialog
          open
          title={pendingConfirm.title}
          confirmLabel={pendingConfirm.confirmLabel}
          onClose={() => setPendingConfirm(null)}
          onConfirm={() => {
            const c = pendingConfirm;
            setPendingConfirm(null);
            void c.onConfirm();
          }}
          body={<p>{pendingConfirm.body}</p>}
        />
      )}
    </>
  );
}
