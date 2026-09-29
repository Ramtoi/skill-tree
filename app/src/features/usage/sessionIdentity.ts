/** Canonical Usage identity shared by all readers and joins. */
export const HARNESS_IDS = ["claude-code", "codex", "pi", "opencode"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

const HARNESS_ALIASES: Record<string, HarnessId> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  pi: "pi",
  opencode: "opencode",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function canonicalHarness(value: unknown): HarnessId | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  return Object.prototype.hasOwnProperty.call(HARNESS_ALIASES, normalized)
    ? HARNESS_ALIASES[normalized]
    : undefined;
}

export function codexRolloutId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const tail = value.split("/").pop() ?? value;
  const match = tail.match(ROLLOUT_UUID_RE);
  if (!match) return undefined;
  return match[1].toLowerCase();
}

export function sessionKey(harness: unknown, rawId: unknown): string | undefined {
  const canonical = canonicalHarness(harness);
  if (!canonical) return undefined;
  const candidate = canonical === "codex" ? codexRolloutId(rawId) : rawId;
  if (typeof candidate !== "string" || !UUID_RE.test(candidate)) return undefined;
  return `${canonical}:${candidate.toLowerCase()}`;
}
