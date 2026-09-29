import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/Button";
import { useBackupLoginPat } from "@/hooks/useBackup";
import { GITHUB_PAT_NEW_URL, scrubTokens } from "@/lib/backupContract";
import { useAppStore } from "@/store";

/**
 * Masked token entry.
 *
 * The value is COMPONENT-LOCAL and cleared the instant it is submitted. It never
 * reaches the Zustand store, a react-query cache entry, a toast, or a log line —
 * the token's only journey is: this field → Tauri arg → child stdin. (The Rust
 * side additionally scrubs token patterns from any output, and `useBackupLoginPat`
 * sets `gcTime: 0` so react-query does not hold the variables either.)
 *
 * Extracted from BackupScreen so the setup journey and the configured screen's
 * credential section render the same field with the same guarantees.
 */
export function PatForm({ onClose }: { onClose: () => void }) {
	const [pat, setPat] = useState("");
	const loginPat = useBackupLoginPat();
	const addToast = useAppStore((s) => s.addToast);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		const token = pat;
		// Clear FIRST so the value is gone from component state even if the await
		// below throws.
		setPat("");
		onClose();
		try {
			await loginPat.mutateAsync(token);
			addToast("success", "Token stored in your keychain");
		} catch (err) {
			// The Rust layer scrubs its own output; this is the belt to that braces
			// — a rejection from anywhere else must not print a token.
			addToast("error", `Couldn't store the token — ${scrubTokens(err)}`);
		}
	}

	return (
		<form onSubmit={submit} className="pat-form" data-testid="pat-form">
			<label htmlFor="pat-input" className="pat-form-label">
				Personal access token — fine-grained, single repo, Contents: Read &amp; Write
			</label>
			<input
				id="pat-input"
				type="password"
				value={pat}
				autoComplete="off"
				spellCheck={false}
				placeholder="github_pat_…"
				className="pat-input"
				onChange={(e) => setPat(e.target.value)}
			/>
			<p className="pat-form-note">
				The token goes straight to your keychain over standard input — it is never written to a
				file, a command line, or this app's state.
			</p>
			<div className="pat-form-actions">
				<Button
					type="submit"
					variant="primary"
					busy={loginPat.isPending}
					disabled={!pat.trim()}
					disabledReason={!pat.trim() ? "Paste a token first" : undefined}
				>
					Store token
				</Button>
				<Button
					icon="arrow-right"
					onClick={() => void openUrl(GITHUB_PAT_NEW_URL)}
					data-testid="pat-create-link"
				>
					Create one on GitHub
				</Button>
				<Button
					onClick={() => {
						setPat("");
						onClose();
					}}
				>
					Cancel
				</Button>
			</div>
		</form>
	);
}
