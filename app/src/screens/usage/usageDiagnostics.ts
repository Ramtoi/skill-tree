import { redactPathsInText } from "@/features/usage/normalizeUsage";
import type { UsageDiagnostic, UsageErrorKind } from "@/features/usage/usageTypes";

const USAGE_ERROR_KINDS: readonly UsageErrorKind[] = [
  "no_usage",
  "access",
  "process_failure",
  "timeout",
  "parse_failure",
];

/** True when the rejected value is a structured `UsageDiagnostic` from the
 *  Rust `usage_*` commands (they reject with the deserialized struct as-is). */
function isUsageDiagnostic(error: unknown): error is UsageDiagnostic {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === "string" && (USAGE_ERROR_KINDS as readonly string[]).includes(kind);
}

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (isUsageDiagnostic(error)) return redactPathsInText(error.message);
  if (error instanceof Error) return error.message;
  try {
    return redactPathsInText(JSON.stringify(error));
  } catch {
    return String(error);
  }
}

export function classifyError(error: unknown): "permission" | "no_usage" | "ccusage" {
  if (isUsageDiagnostic(error)) {
    if (error.kind === "access") return "permission";
    if (error.kind === "no_usage") return "no_usage";
    return "ccusage";
  }
  const text = errorText(error).toLowerCase();
  if (
    text.includes("permission") ||
    text.includes("access") ||
    text.includes("eacces") ||
    text.includes("sandbox")
  ) {
    return "permission";
  }
  if (text.includes("no_usage") || text.includes("no usage") || text.includes("not detected")) {
    return "no_usage";
  }
  return "ccusage";
}

const DIAGNOSTIC_HEADER =
  "Skill Tree Local Agent Usage diagnostic\nCommand: ccusage --sections daily,weekly,monthly,session --by-agent --json --offline";

/** Build the copyable diagnostic string. For a structured `UsageDiagnostic`
 *  the free-form stdout/stderr/detail/command fields can carry local
 *  absolute paths, so every such field is path-redacted before inclusion. */
export function buildDiagnostic(error: unknown): string {
  if (!isUsageDiagnostic(error)) {
    return `${DIAGNOSTIC_HEADER}\nError: ${errorText(error)}`;
  }
  const lines = [DIAGNOSTIC_HEADER, `Kind: ${error.kind}`, `Error: ${redactPathsInText(error.message)}`];
  if (error.detail) lines.push(`Detail: ${redactPathsInText(error.detail)}`);
  if (typeof error.exit_code === "number") lines.push(`Exit code: ${error.exit_code}`);
  if (error.source?.command) lines.push(`Runner: ${redactPathsInText(error.source.command)}`);
  if (error.stdout) lines.push(`stdout: ${redactPathsInText(error.stdout)}`);
  if (error.stderr) lines.push(`stderr: ${redactPathsInText(error.stderr)}`);
  return lines.join("\n");
}

export function copyDiagnosticToClipboard(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}
