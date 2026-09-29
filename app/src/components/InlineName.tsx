import {
  useEffect,
  useImperativeHandle,
  type Ref,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Button } from "./Button";
import { Icon } from "./Icon";

export interface InlineNameHandle {
  startEditing: () => void;
}

export interface InlineNameProps {
  ref?: Ref<InlineNameHandle>;
  /** The identifier as it is now. Mono, rendered exactly as given. */
  value: string;
  /** What the identifier is, for the accessible name ("Project name"). */
  label: string;
  /** Called with the trimmed draft when the user commits a changed, valid
   *  name. Resolve to close the field; reject to keep it open with the draft
   *  intact so the user can retry (the caller reports the error). */
  onSave: (next: string) => Promise<void> | void;
  /** A message when `next` may not be saved, else `null`. Runs on every
   *  keystroke; the Save button stays disabled and the field reads invalid
   *  while it returns a message. */
  validate?: (next: string) => string | null;
  /** Shown dim at rest when `value` is empty (an optional identifier such as
   *  a version), and as the field's placeholder while editing. */
  placeholder?: string;
  /** Commit a valid draft when the field loses focus instead of restoring the
   *  old value. For a caller whose `onSave` only STAGES the value (the skill
   *  editor's identity rows, written later by ⌘S): a click on that Save
   *  button blurs the field first, and restoring there would throw the edit
   *  away silently. Leave off when `onSave` is itself the mutation. */
  commitOnBlur?: boolean;
  className?: string;
  /** Mirrors the live client-validation message while editing (`null` once
   *  closed or valid) — for a caller that renders it as a VISIBLE line
   *  elsewhere on screen (a keyboard/touch user never hovers `title`).
   *  Opt-in only; omitting it changes nothing for an existing caller. */
  onValidityChange?: (error: string | null) => void;
}

/**
 * An identifier that edits in place. At rest it is the plain mono name with
 * a light hover affordance (a lift in colour and a pencil glyph). A click
 * swaps in a text field sized to its content; once the draft differs from
 * `value` and passes `validate`, a small Save button appears beside it.
 * Enter saves, Escape restores, and leaving the field without saving
 * restores too — an inline edit is never half-committed.
 *
 * Reversibility belongs to the caller: pair `onSave` with an undo toast
 * rather than a confirm dialog (a rename is cheap to reverse).
 */
export function InlineName({
  ref,
  value,
  label,
  onSave,
  validate,
  placeholder,
  commitOnBlur = false,
  className,
  onValidityChange,
}: InlineNameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // A rename that lands re-renders this with the new `value`; the field is
  // already closed by then, but a stale draft must not survive to the next
  // open.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const trimmed = draft.trim();
  const dirty = trimmed !== value;
  const error = dirty ? (validate?.(trimmed) ?? null) : null;
  const canSave = dirty && !error && !saving;

  // Opt-in mirror of the live message for a caller that paints it visibly.
  useEffect(() => {
    onValidityChange?.(editing ? error : null);
  }, [editing, error, onValidityChange]);

  const open = () => {
    setDraft(value);
    setEditing(true);
  };
  useImperativeHandle(ref, () => ({ startEditing: open }));

  const close = () => {
    setEditing(false);
    setDraft(value);
  };

  const commit = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch {
      // The caller has already surfaced the failure; keep the draft so the
      // user can correct it instead of retyping.
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (dirty) void commit();
      else close();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  // A press on the Save button must not blur the field first — WebKit does
  // not move focus to a clicked button, so `relatedTarget` cannot be relied
  // on; keeping focus where it is makes the click land before any blur.
  const keepFocus = (e: MouseEvent) => {
    if (e.target !== inputRef.current) e.preventDefault();
  };

  if (!editing) {
    return (
      <button
        type="button"
        className={`inline-name${className ? ` ${className}` : ""}`}
        onClick={open}
        title={`Rename ${label.toLowerCase()}`}
        aria-label={`Rename ${label.toLowerCase()}: ${value}`}
      >
        <span className="inline-name-text" data-empty={!value || undefined}>
          {value || placeholder}
        </span>
        <Icon name="edit" size={12} className="inline-name-glyph" />
      </button>
    );
  }

  return (
    <span
      className={`inline-name is-editing${className ? ` ${className}` : ""}`}
      onMouseDown={keepFocus}
    >
      <input
        ref={inputRef}
        className="inline-name-input"
        value={draft}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        disabled={saving}
        placeholder={placeholder}
        style={{
          width: `${Math.max(draft.length, placeholder?.length ?? 0, 3) + 1}ch`,
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (saving) return;
          if (commitOnBlur && canSave) void commit();
          else close();
        }}
      />
      {dirty && (
        <Button
          size="sm"
          variant="soft"
          icon="check"
          busy={saving}
          disabled={!canSave}
          disabledReason={error ?? undefined}
          className="inline-name-save"
          onClick={() => void commit()}
        >
          Save
        </Button>
      )}
    </span>
  );
}
