import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/Button";
import { ErrorCard } from "@/components/ErrorCard";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/store";

/** Structured runtime status from the `runtime_preflight` Tauri command. */
export type Preflight = {
  ok: boolean;
  reason: "none" | "no-python" | "python-too-old" | "hub-unrunnable";
  detail?: string | null;
  python?: string | null;
};

/** Minimum Python the bundled hub.py supports — mirrors MIN_PYTHON. */
const MIN_PYTHON = "3.9";

const mono = { color: "var(--cyan)", fontFamily: "var(--font-mono)" } as const;

function Mono({ children }: { children: ReactNode }) {
  return <code style={mono}>{children}</code>;
}

type Copy = {
  title: string;
  description: ReactNode;
  cmd: ReactNode;
  fix: ReactNode[];
};

/**
 * The onboarding runtime-status screen. Renders distinct, actionable guidance
 * per failure mode so an upstream runtime fault is never misreported as a
 * registry error downstream. Driven by the `runtime_preflight` result, plus a
 * `bootstrap-failed` branch for when the runtime is healthy but `bootstrap_check`
 * itself failed.
 */
export function PythonError({
  preflight,
  bootstrapError,
}: {
  preflight?: Preflight;
  bootstrapError?: string;
} = {}) {
  const queryClient = useQueryClient();
  const setDegradedMode = useAppStore((s) => s.setDegradedMode);
  const toast = useToast();

  const python = preflight?.python ?? "python3";
  // Runtime is fine but bootstrap_check errored → show that error honestly.
  const reason: Preflight["reason"] | "bootstrap-failed" =
    bootstrapError && preflight?.ok
      ? "bootstrap-failed"
      : preflight?.reason ?? "no-python";

  const copy: Copy = ((): Copy => {
    switch (reason) {
      case "python-too-old":
        return {
          title: "Python is too old",
          description: (
            <>
              Skill Tree needs Python <strong>{MIN_PYTHON}+</strong> to run{" "}
              <Mono>hub.py</Mono>
              {preflight?.detail ? (
                <>
                  , but the interpreter at <Mono>{python}</Mono> reports{" "}
                  <strong>{preflight.detail}</strong>.
                </>
              ) : (
                "."
              )}
            </>
          ),
          cmd: `${python} --version`,
          fix: [
            <>
              Install a newer Python — e.g. <Mono>brew install python@3.12</Mono>
            </>,
            <>
              Restart Skill Tree, or click <strong>Recheck runtime</strong> below.
            </>,
          ],
        };
      case "hub-unrunnable":
        return {
          title: "Skill Tree's helper couldn't start",
          description: (
            <>
              The bundled <Mono>hub.py</Mono> failed its self-check on the
              interpreter at <Mono>{python}</Mono>. The underlying error is below.
            </>
          ),
          cmd: (preflight?.detail || "hub.py selfcheck failed").trim(),
          fix: [
            <>
              This usually means a corrupt or incomplete install — try
              reinstalling Skill Tree.
            </>,
            <>
              If it persists, the error above is the real cause; include it when
              reporting.
            </>,
          ],
        };
      case "bootstrap-failed":
        return {
          title: "Couldn't initialize Skill Tree",
          description: (
            <>
              The runtime is healthy, but preparing your registry failed. The
              underlying error is below.
            </>
          ),
          cmd: (bootstrapError || "bootstrap check failed").trim(),
          fix: [
            <>
              Click <strong>Recheck runtime</strong> below to retry.
            </>,
            <>If it persists, the error above is the real cause.</>,
          ],
        };
      case "no-python":
      default:
        return {
          title: "Python 3 not detected",
          description: (
            <>
              Skill Tree delegates registry operations to <Mono>hub.py</Mono>. We
              couldn't find a working Python 3 runtime on your <Mono>$PATH</Mono>{" "}
              or in the usual install locations.
            </>
          ),
          cmd: "command not found: python3",
          fix: [
            <>
              Install Python {MIN_PYTHON}+ — recommended via{" "}
              <Mono>brew install python@3.12</Mono>
            </>,
            <>
              Restart Skill Tree, or click <strong>Recheck runtime</strong> below.
            </>,
          ],
        };
    }
  })();

  return (
    <div style={{ height: "100%", overflow: "auto", background: "var(--bg-0)" }}>
      <ErrorCard
        title={copy.title}
        description={copy.description}
        cmd={copy.cmd}
        fix={copy.fix}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDegradedMode(true)}>
              Continue in degraded mode
            </Button>
            <Button
              variant="primary"
              icon="refresh"
              onClick={async () => {
                toast.info("Rechecking runtime…");
                // Force a fresh probe (the Rust side re-detects on each call now
                // that a failed result is no longer cached), then report the
                // real outcome so the recheck never silently does nothing.
                await queryClient.refetchQueries({ queryKey: ["python"] });
                const pf = queryClient.getQueryData<Preflight>(["python"]);
                if (pf?.ok) {
                  await queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
                  toast.success("Runtime detected — continuing");
                } else if (pf?.reason === "no-python") {
                  toast.error(
                    "Still no Python 3 found",
                    "Install Python 3.9+, then recheck — no restart needed.",
                  );
                } else {
                  toast.error(
                    "Runtime still not ready",
                    pf?.detail ? String(pf.detail).split("\n")[0] : pf?.reason,
                  );
                }
              }}
            >
              Recheck runtime
            </Button>
          </>
        }
      />
    </div>
  );
}
