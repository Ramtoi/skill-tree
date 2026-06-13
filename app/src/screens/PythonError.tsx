import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/Button";
import { ErrorCard } from "@/components/ErrorCard";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/store";

export function PythonError() {
  const queryClient = useQueryClient();
  const setDegradedMode = useAppStore((s) => s.setDegradedMode);
  const toast = useToast();

  return (
    <div
      style={{ height: "100%", overflow: "auto", background: "var(--bg-0)" }}
    >
      <ErrorCard
        title="Python 3 not detected"
        description={
          <>
            Skill Tree delegates registry operations to{" "}
            <code
              style={{
                color: "var(--cyan)",
                fontFamily: "var(--font-mono)",
              }}
            >
              hub.py
            </code>
            . We couldn't find a working Python 3 runtime on your{" "}
            <code
              style={{
                color: "var(--cyan)",
                fontFamily: "var(--font-mono)",
              }}
            >
              $PATH
            </code>
            .
          </>
        }
        cmd="command not found: python3"
        fix={[
          <>
            Install Python 3.11+ — recommended via{" "}
            <code
              style={{
                color: "var(--cyan)",
                fontFamily: "var(--font-mono)",
              }}
            >
              brew install python@3.12
            </code>
          </>,
          <>
            Restart Skill Tree, or click <strong>Recheck runtime</strong> below.
          </>,
        ]}
        actions={
          <>
            <Button variant="ghost" onClick={() => setDegradedMode(true)}>
              Continue in degraded mode
            </Button>
            <Button
              variant="primary"
              icon="refresh"
              onClick={async () => {
                await queryClient.invalidateQueries({ queryKey: ["python"] });
                toast.success("Rechecking Python runtime");
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
