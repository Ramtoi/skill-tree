// Bundle identity color. Bundles are identified primarily by their emoji + mono
// name; this adds a deterministic tint from the dedicated low-chroma identity
// ramp (--id-0..7, see App.css). It is decoration, NOT meaning — a bundle's color
// never implies status, scope, or provenance, and is never a semantic accent token.

const RAMP_SIZE = 8;

/** djb2 — small, stable string hash so a name always maps to the same hue. */
function hash(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = (h * 33) ^ name.charCodeAt(i);
  }
  return h >>> 0;
}

export function bundleColor(name: string): string {
  return `var(--id-${hash(name) % RAMP_SIZE})`;
}
