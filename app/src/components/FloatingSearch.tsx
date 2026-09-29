import {
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";
import { Icon } from "./Icon";
import { Chip, Chips } from "./Chips";
import { Kbd } from "./Kbd";
import { SearchInput } from "./SearchInput";
import type { SearchKind } from "@/lib/unifiedSearch";

/** `mousedown` on a chip/clear/pill button must not blur the input first —
 * a blur while the query is empty would flip `open` false and unmount the
 * stack before the click lands. Also required on the kind pill: a
 * mousedown-focuses browser (Chromium/WebView2/WebKitGTK) would otherwise
 * set `focusWithin` true right before the click clears the kind and the
 * pill unmounts, so the compensating `blur` never fires and the stack is
 * stuck open (review M3). */
function preventBlur(e: ReactMouseEvent) {
  e.preventDefault();
}

export interface FloatingSearchKindOption {
  value: SearchKind | "all";
  label: string; // "ALL" | "SKILLS" | "MCP" | "BUNDLES" | "SNIPPETS"
  icon?: string;
  count: number;
}

export interface FloatingSearchProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;

  kinds: FloatingSearchKindOption[];
  activeKind: SearchKind | "all";
  onKindChange: (k: SearchKind | "all") => void;

  /** Fired on Enter when the query is non-empty — every result renders in
   *  the host's OWN body (§11: the bar never lists matches itself), so the
   *  bar hands the keyboard off to it. G13: `true` now means "the host
   *  NAVIGATED" (it opened the cursor row) — `FloatingSearch` only
   *  `preventDefault()`s the keystroke when the host actually did so. */
  onCommit?: () => boolean;

  /** S2/G3: ArrowUp/ArrowDown from the focused input move the result cursor
   *  by ±1 without moving DOM focus off the input (combobox pattern). Input-
   *  only (G5) — a focused kind chip never reaches this. */
  onMove?: (delta: 1 | -1) => void;

  /** G3: unmodified Tab from the focused input hands DOM focus to the cursor
   *  row (roving tabindex) instead of falling through to the dock's own next
   *  control, since the dock renders AFTER the results in DOM order. Returns
   *  `true` when it moved focus — only then does `FloatingSearch`
   *  `preventDefault()` the keystroke, so Tab still reaches the clear button
   *  / kind chips natively when there is no row to focus. Shift+Tab is
   *  always left native. */
  onFocusCursor?: () => boolean;

  /** Stamps `data-screen-search` for the `/` hotkey. */
  screenSearch?: boolean;

  /** A persistent, always-visible pill at the bar's leading edge, naming the
   *  pool the bar is scoped to (the Library's bundle mode). Mirrors the kind
   *  pill's shape; its button and Backspace in an empty input call `onClear`.
   *  Not part of the Escape ladder above. */
  context?: {
    icon: string;
    label: string;
    onClear: () => void;
    testid: string;
  };

  /** R3/H5: exposes the underlying `<input>` so the host can refocus it (and
   *  place the caret) when restoring attention on return — merged with the
   *  component's own internal ref, which still needs the node for caret/
   *  Tab handling above. */
  inputRef?: Ref<HTMLInputElement>;
}

export function FloatingSearch({
  value,
  onChange,
  placeholder,
  kinds,
  activeKind,
  onKindChange,
  onCommit,
  onMove,
  onFocusCursor,
  screenSearch,
  context,
  inputRef: externalInputRef,
}: FloatingSearchProps) {
  const [focusWithin, setFocusWithin] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function setInputRefs(node: HTMLInputElement | null) {
    inputRef.current = node;
    if (!externalInputRef) return;
    if (typeof externalInputRef === "function") externalInputRef(node);
    else (externalInputRef as { current: HTMLInputElement | null }).current = node;
  }

  const open = focusWithin || value.length > 0;
  const state = value ? "typing" : focusWithin ? "focused" : "idle";
  const activeOption = kinds.find((k) => k.value === activeKind);

  function handleFocus() {
    setFocusWithin(true);
  }

  function handleBlur(e: FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setFocusWithin(false);
    }
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (value !== "") {
        e.preventDefault();
        onChange("");
        return;
      }
      if (activeKind !== "all") {
        e.preventDefault();
        onKindChange("all");
        return;
      }
      // Blur whatever inside the dock actually holds focus — it may be a
      // kind chip, not the input (review M2: `inputRef.current?.blur()`
      // blurred an unfocused node and left the row with no way out).
      (e.currentTarget.querySelector(":focus") as HTMLElement | null)?.blur();
      return;
    }

    // S2/S3/G3/G5: everything below is the INPUT's contract only — a focused
    // kind chip (a real <button>) keeps its own native Enter/Space
    // activation and its own roving ArrowLeft/Right handler
    // (`handleKindsKeyDown` below), never double-handled here.
    if (e.target !== inputRef.current) return;

    // A modifier on arrow/Tab/Enter means the user wants native caret/
    // selection behaviour (⌥←/→ word jump, ⌘←/→ line jump, ⇧-arrow select,
    // ⌘Enter, etc.) — bail out before touching cursor/kind state so none of
    // it is hijacked and the keystroke is never `preventDefault()`d.
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;

    switch (e.key) {
      case "Backspace":
        if (value === "" && context) {
          e.preventDefault();
          context.onClear();
        }
        return;
      case "ArrowDown":
        if (onMove) {
          e.preventDefault();
          onMove(1);
        }
        return;
      case "ArrowUp":
        if (onMove) {
          e.preventDefault();
          onMove(-1);
        }
        return;
      case "ArrowLeft":
      case "ArrowRight": {
        // S3: unconditional cycle through `kinds` in its given order
        // (ALL → SKILLS → MCP → BUNDLES → SNIPPETS), wrapping both ways —
        // caret movement by bare arrow inside the query is given up on
        // purpose (⌥←/→, ⌘←/→, Home/End, Shift+arrows, and the mouse still
        // move the caret).
        if (kinds.length === 0) return;
        e.preventDefault();
        const from = kinds.findIndex((k) => k.value === activeKind);
        const delta = e.key === "ArrowRight" ? 1 : -1;
        const next = kinds[(Math.max(from, 0) + delta + kinds.length) % kinds.length];
        if (next) onKindChange(next.value);
        return;
      }
      case "Tab":
        if (!e.shiftKey && onFocusCursor) {
          const moved = onFocusCursor();
          if (moved) e.preventDefault();
        }
        return;
      case "Enter":
        // Enter is the INPUT's contract only (review M1, kept above via the
        // `e.target` guard).
        if (value.trim() !== "") {
          const handled = onCommit?.() ?? false;
          if (handled) e.preventDefault();
        }
        return;
      default:
        return;
    }
  }

  /** Roving tabindex on the kind chip row: ArrowLeft/ArrowRight both move
   *  focus AND press the newly-focused chip (activate-on-arrow). */
  function handleKindsKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const buttons = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>(".chip"),
    );
    if (buttons.length === 0) return;
    const domIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const from = domIndex === -1 ? kinds.findIndex((k) => k.value === activeKind) : domIndex;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = (from + delta + buttons.length) % buttons.length;
    buttons[next].focus();
    const target = kinds[next];
    if (target) onKindChange(target.value);
  }

  return (
    <div
      className="floating-search"
      data-testid="floating-search"
      data-state={state}
      data-open={open}
      data-focus={focusWithin}
      data-active-kind={activeKind}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <SearchInput
        className="floating-search-bar"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        screenSearch={screenSearch}
        inputTestId="floating-search-input"
        inputRef={setInputRefs}
        leading={
          context || (activeOption && activeKind !== "all") ? (
            <>
              {context && (
                <Chip
                  pressed
                  icon={context.icon}
                  onClick={context.onClear}
                  onMouseDown={preventBlur}
                  ariaLabel={`${context.label}. Leave.`}
                  dataTestid={context.testid}
                >
                  {context.label}
                  <Icon name="x" size={10} />
                </Chip>
              )}
              {activeOption && activeKind !== "all" && (
                <Chip
                  pressed
                  icon={activeOption.icon}
                  onClick={() => onKindChange("all")}
                  onMouseDown={preventBlur}
                  ariaLabel={`Kind: ${activeOption.label.toLowerCase()}. Clear filter.`}
                  dataTestid="floating-search-kind-pill"
                >
                  {activeOption.label}
                  <Icon name="x" size={10} />
                </Chip>
              )}
            </>
          ) : undefined
        }
        trailing={
          value ? (
            <button
              type="button"
              className="floating-search-clear"
              aria-label="Clear search"
              onMouseDown={preventBlur}
              onClick={() => onChange("")}
            >
              <Icon name="x" size={11} />
            </button>
          ) : !focusWithin ? (
            // Idle discoverability hint for the `/` hotkey — already announced
            // via the global keymap, so this is presentational only. `false`
            // (not `undefined`) once focused: `SearchInput`'s `??` fallback
            // would otherwise repaint its own default `/` hint in its place.
            <span className="floating-search-hint" aria-hidden="true">
              <Kbd>/</Kbd>
            </span>
          ) : (
            false
          )
        }
        inputProps={{
          "aria-label": "Search skills, MCP servers, bundles and snippets",
          autoComplete: "off",
        }}
      />

      {open && (
        <div className="floating-search-stack">
          <div
            className="floating-search-kinds"
            data-testid="floating-search-kinds"
            onMouseDown={preventBlur}
            onKeyDown={handleKindsKeyDown}
          >
            <Chips role="group" ariaLabel="Kind">
              {kinds.map((k) => (
                <Chip
                  key={k.value}
                  icon={k.icon}
                  count={k.count}
                  pressed={k.value === activeKind}
                  tabIndex={k.value === activeKind ? 0 : -1}
                  title={`Show ${k.label.toLowerCase()}`}
                  onClick={() => onKindChange(k.value)}
                >
                  {k.label}
                </Chip>
              ))}
            </Chips>
          </div>
        </div>
      )}
    </div>
  );
}
