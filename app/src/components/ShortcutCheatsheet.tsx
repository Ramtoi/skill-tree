import { Fragment } from "react";
import { Modal } from "./Modal";
import { Kbd } from "./Kbd";
import { useAppStore } from "@/store";
import { KEYMAP, GLOBAL_STATIC_HINTS, type KeyGroup } from "@/lib/keymap";

/** Cheatsheet section order. Only groups with ≥1 registry entry render. */
const GROUP_ORDER: KeyGroup[] = ["Navigation", "Create", "List", "Palette"];

/** Render one chord hint string as a sequence of <Kbd> tokens. */
function HintKbd({ hint }: { hint: string }) {
  const tokens = hint.split(" ");
  return (
    <span className="cheatsheet-hint">
      {tokens.map((t, i) => (
        <Kbd key={i}>{t}</Kbd>
      ))}
    </span>
  );
}

/**
 * The `?` shortcut cheatsheet (ux-command-layer D1/F4). Generated from `KEYMAP`
 * grouped by `KeyGroup`, plus a static "Global" block for the keys owned by
 * App.tsx/screens (⌘K, /, ⌘S, Esc) that are intentionally NOT registry entries.
 * A shown hint is the same entry whose handler the chord dispatcher runs.
 */
export function ShortcutCheatsheet() {
  const open = useAppStore((s) => s.cheatsheetOpen);
  const close = useAppStore((s) => s.closeCheatsheet);

  return (
    <Modal open={open} onClose={close} title="Keyboard shortcuts" width={440}>
      <div className="cheatsheet">
        {GROUP_ORDER.map((group) => {
          const rows = KEYMAP.filter((b) => b.group === group);
          if (rows.length === 0) return null;
          return (
            <Fragment key={group}>
              <div className="cheatsheet-group">{group}</div>
              {rows.map((b) => (
                <div className="cheatsheet-row" key={b.id} data-binding-id={b.id}>
                  <span className="cheatsheet-label">{b.label}</span>
                  <HintKbd hint={b.hint} />
                </div>
              ))}
            </Fragment>
          );
        })}
        <div className="cheatsheet-group" data-static="true">
          Global
        </div>
        {GLOBAL_STATIC_HINTS.map((g) => (
          <div className="cheatsheet-row" key={g.hint} data-static="true">
            <span className="cheatsheet-label">{g.label}</span>
            <HintKbd hint={g.hint} />
          </div>
        ))}
      </div>
    </Modal>
  );
}
