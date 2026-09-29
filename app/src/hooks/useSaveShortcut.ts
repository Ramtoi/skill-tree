import { useEffect } from "react";

/**
 * Wires ⌘S / Ctrl+S to a save callback — the app's one save-shortcut
 * contract. Fires only while `dirty`, not already `saving`, and not
 * `saveDisabled` for some other reason (a create-mode screen mid-validation,
 * say) — a mid-save spam of ⌘S must never double the write.
 *
 * Shared by `DocumentEditorShell` (every shell-composed editor) and any
 * screen that owns its own save flow without composing the shell (the
 * bundle editor is the one today).
 */
export function useSaveShortcut(
	onSave: () => void,
	dirty: boolean,
	saving?: boolean,
	saveDisabled?: boolean,
) {
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "s") {
				e.preventDefault();
				if (dirty && !saveDisabled && !saving) onSave();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [dirty, saveDisabled, saving, onSave]);
}
