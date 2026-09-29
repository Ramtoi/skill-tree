import { useEffect, type RefObject } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { InlineName, type InlineNameHandle } from "@/components/InlineName";
import { SLUG_RE } from "@/lib/paletteVerbs";
import type { Registry } from "@/types";

/** One editor for title clicks, header actions and navigator rename requests. */
export function BundleName({ name, bundles, onSave, editorRef }: {
  name: string;
  bundles: Registry["bundles"];
  onSave: (next: string) => Promise<void>;
  editorRef: RefObject<InlineNameHandle | null>;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  useEffect(() => {
    if (searchParams.get("rename") !== "1") return;
    editorRef.current?.startEditing();
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("rename");
      return next;
    }, { replace: true, state: location.state });
  }, [searchParams, setSearchParams, location.state, editorRef]);

  return (
    <InlineName
      ref={editorRef}
      value={name}
      label="Bundle name"
      onSave={onSave}
      validate={(next) =>
        !SLUG_RE.test(next)
          ? "Use lowercase letters, numbers and hyphens"
          : next in bundles
            ? "A bundle with this name already exists"
            : null
      }
    />
  );
}
