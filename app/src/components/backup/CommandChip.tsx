import { Button } from "@/components/Button";
import { copyToClipboard } from "@/lib/clipboard";
import { useAppStore } from "@/store";

/**
 * A shell command the user is meant to run themselves: mono, on its own chip,
 * with a copy button beside it.
 *
 * Extracted from the credential ladder so every command on the backup surface
 * looks and behaves the same. The one that wasn't — the `gh auth switch` line
 * built inline out of JSX text + an interpolated login — rendered as
 * `gh auth switch--user me`, which is a command that does not exist. A command
 * is an identifier, not prose: it belongs in one string, in one element.
 *
 * The app never RUNS it. Installing software or switching someone's GitHub
 * account from a GUI is a different consent from anything else this screen asks
 * for.
 */
export function CommandChip({
	command,
	label,
	after,
	testId,
}: {
	command: string;
	/** Optional lead-in ("Install it, then sign in"). */
	label?: React.ReactNode;
	/** Optional trailing note ("then `gh auth login`"). */
	after?: React.ReactNode;
	testId?: string;
}) {
	const addToast = useAppStore((s) => s.addToast);
	return (
		<span className="cred-fix-cmd" data-testid={testId}>
			{label && <span className="cred-fix-label">{label}</span>}
			<code className="cred-cmd">{command}</code>
			<Button
				size="sm"
				icon="copy"
				title={`Copy “${command}”`}
				onClick={() => {
					copyToClipboard(command);
					addToast("info", `Copied — ${command}`);
				}}
			/>
			{after && <span className="cred-fix-then">{after}</span>}
		</span>
	);
}
