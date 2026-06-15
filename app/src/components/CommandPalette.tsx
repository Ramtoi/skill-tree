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
import { invoke } from "@tauri-apps/api/core";
import { useRegistry } from "@/hooks/useRegistry";
import { useAppStore } from "@/store";
import { queryClient } from "@/lib/queryClient";
import { trackProcess } from "@/lib/trackProcess";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";

type ItemKind = "action" | "project" | "bundle" | "skill";

interface PaletteItem {
  kind: ItemKind;
  id: string;
  name: string;
  icon: string;
  hint: string;
  exec: () => void;
}

interface IndexedPaletteItem extends PaletteItem {
  _idx: number;
}

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
  const setSyncStatus = useAppStore((s) => s.setSyncStatus);
  const setLastSyncedAt = useAppStore((s) => s.setLastSyncedAt);

  const { data: registry } = useRegistry();
  const navigate = useNavigate();

  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const close = useCallback(() => {
    closePalette();
  }, [closePalette]);

  const handleSync = useCallback(async () => {
    setSyncStatus("syncing");
    try {
      await trackProcess(
        {
          title: "Registry sync",
          body: "writing .claude / .agents",
          kind: "local",
        },
        async () => {
          const result = await invoke<{ success: boolean; output: string }>(
            "hub_cmd",
            { args: ["sync"] },
          );
          if (!result.success) throw new Error(result.output);
          await queryClient.invalidateQueries({ queryKey: ["registry"] });
          return result;
        },
        { successBody: "registry aligned", retry: () => void handleSync() },
      );
      setSyncStatus("synced");
      setLastSyncedAt(new Date());
      setTimeout(() => setSyncStatus("idle"), 5000);
    } catch {
      setSyncStatus("error");
    }
  }, [setSyncStatus, setLastSyncedAt]);

  // Reset state and focus when palette opens.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Reset active row whenever query changes.
  useEffect(() => {
    setActive(0);
  }, [q]);

  const items = useMemo<PaletteItem[]>(() => {
    const all: PaletteItem[] = [];

    // Actions
    all.push({
      kind: "action",
      id: "new-skill",
      name: "New skill",
      icon: "plus",
      hint: "C S",
      exec: () => navigate("/?new=1"),
    });
    all.push({
      kind: "action",
      id: "new-bundle",
      name: "New bundle",
      icon: "bundle",
      hint: "C B",
      exec: () => navigate("/?addBundle=1"),
    });
    all.push({
      kind: "action",
      id: "sync",
      name: "Sync registry to agent folders",
      icon: "sync",
      hint: "⌘R",
      exec: handleSync,
    });
    all.push({
      kind: "action",
      id: "lib",
      name: "Open library",
      icon: "view.library",
      hint: "G L",
      exec: () => navigate("/"),
    });
    all.push({
      kind: "action",
      id: "harnesses",
      name: "Open harnesses",
      icon: "plug",
      hint: "G H",
      exec: () => navigate("/harnesses"),
    });
    all.push({
      kind: "action",
      id: "snippets",
      name: "Open snippets",
      icon: "snippet",
      hint: "G N",
      exec: () => navigate("/snippets"),
    });

    if (registry) {
      // Projects
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

      // Bundles
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

      // Skills
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

    const lq = q.trim().toLowerCase();
    if (!lq) return all.slice(0, 24);
    return all
      .filter((x) => x.name.toLowerCase().includes(lq))
      .slice(0, 30);
  }, [q, registry, navigate, handleSync]);

  // Group items for rendering, preserving the flat index for keyboard nav.
  const groups = useMemo(() => {
    const out: Partial<Record<ItemKind, IndexedPaletteItem[]>> = {};
    items.forEach((it, idx) => {
      const bucket = out[it.kind] ?? (out[it.kind] = []);
      bucket.push({ ...it, _idx: idx });
    });
    return out;
  }, [items]);

  function handleKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active];
      if (it) {
        it.exec();
        close();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  if (!open) return null;

  return (
    <div className="palette-backdrop" onClick={close}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-head">
          <Icon
            name="command"
            size={16}
            style={{ color: "var(--violet-2)" }}
          />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Jump to skill, project, bundle, or action…"
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="palette-list">
          {GROUP_ORDER.map((g) => {
            const groupItems = groups[g];
            if (!groupItems || groupItems.length === 0) return null;
            return (
              <Fragment key={g}>
                <div className="palette-section">
                  {GROUP_TITLES[g]} · {groupItems.length}
                </div>
                {groupItems.map((it) => (
                  <div
                    key={it.id}
                    className="palette-item"
                    data-active={it._idx === active}
                    onMouseEnter={() => setActive(it._idx)}
                    onClick={() => {
                      it.exec();
                      close();
                    }}
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
        <div className="palette-foot">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>esc</Kbd> dismiss
          </span>
          <span style={{ marginLeft: "auto" }}>⌘K from anywhere</span>
        </div>
      </div>
    </div>
  );
}
