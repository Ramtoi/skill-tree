// One place to copy text to the clipboard. Fire-and-forget: the Clipboard API
// may be unavailable (no `navigator.clipboard`) or reject (permissions); either
// way a failed copy is non-fatal, so the rejection is swallowed.
export function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
}
