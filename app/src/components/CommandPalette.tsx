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
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { hintForBindingId } from "@/lib/keymap";
import {
  PALETTE_VERBS,
  SLUG_RE,
  type PaletteOption,
  type PaletteVerb,
} from "@/lib/paletteVerbs";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";

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

/** Root-stage list caps: how many items render before "+N more" kicks in. */
const ROOT_CAP_NO_QUERY = 24;
const ROOT_CAP_QUERY = 30;

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

  const { data: registry } = useRegistry();
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
  const inputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => {
    closePalette();
  }, [closePalette]);

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
        void verb.run(nextPicked, { navigate, runUndoable });
        close();
      }
    },
    [verb, currentArg, picked, argIndex, navigate, runUndoable, close],
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
    action("add-project", "Add project", "project", {
      exec: () => navigate("/?addProject=1"),
    });
    action("tips", "Show tips tour", "spark", { exec: () => openTips() });
    action("sync", "Sync registry to agent folders", "sync", { exec: handleSync });
    action("lib", "Open library", "view.library", {
      bindingId: "nav.library",
      exec: () => navigate("/"),
    });
    action("harnesses", "Open harnesses", "plug", {
      bindingId: "nav.harnesses",
      exec: () => navigate("/harnesses"),
    });
    action("snippets", "Open snippets", "snippet", {
      bindingId: "nav.snippets",
      exec: () => navigate("/snippets"),
    });
    action("permissions", "Open permissions", "shield", {
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
    harnesses
      .filter((h) => h.installed)
      .forEach((h) => {
        action(`harness-${h.id}`, `Configure ${h.label}`, "plug", {
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
  }, [registry, harnesses, navigate, handleSync, openTips]);

  // ── Argument-stage list options (for kind:"list") ──
  const argOptions = useMemo<PaletteOption[]>(() => {
    if (!verb || !currentArg || currentArg.kind !== "list" || !registry) return [];
    return currentArg.options?.(picked, { registry }) ?? [];
  }, [verb, currentArg, picked, registry]);

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
    // Root stage.
    if (!lq) return rootItems.slice(0, ROOT_CAP_NO_QUERY);
    return rootItems
      .filter((x) => x.name.toLowerCase().includes(lq))
      .slice(0, ROOT_CAP_QUERY);
  }, [q, verb, currentArg, argOptions, rootItems, advance]);

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

  if (!open) return null;

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
    <div className="palette-backdrop" onClick={close}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
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
          <Icon name="command" size={16} style={{ color: "var(--violet-2)" }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={handleKey}
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
          <div className="palette-list">
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
                    <div
                      key={it.id}
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
  );
}
