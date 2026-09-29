// One place to copy text to the clipboard. Fire-and-forget by default: the
// Clipboard API may be unavailable (no `navigator.clipboard`) or reject
// (permissions); a caller with no feedback of its own treats either as
// non-fatal. A caller that DOES need to tell the user (a toast) passes
// `onSuccess`/`onError` — both optional, so every existing one-argument call
// keeps its exact silent behaviour.
export function copyToClipboard(
  text: string,
  callbacks?: { onSuccess?: () => void; onError?: () => void },
): void {
  if (!navigator.clipboard) {
    callbacks?.onError?.();
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => callbacks?.onSuccess?.(),
    () => callbacks?.onError?.(),
  );
}
