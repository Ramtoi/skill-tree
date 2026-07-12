/**
 * Collapse a user's home directory to `~` for compact display.
 * `/Users/ada/Dev/app` → `~/Dev/app`, `/home/ada/x` → `~/x`,
 * `C:\Users\ada\x` → `~\x`. Anything else is returned unchanged.
 */
export function shortenPath(path: string): string {
	if (!path) return path;
	const unix = path.match(/^(\/(?:Users|home)\/[^/]+)(\/.*)?$/);
	if (unix) return `~${unix[2] ?? ""}`;
	const win = path.match(/^([A-Za-z]:\\Users\\[^\\]+)(\\.*)?$/);
	if (win) return `~${win[2] ?? ""}`;
	return path;
}
