import type { ReactNode } from "react";
import { useNavigate, type NavigateOptions } from "react-router-dom";
import { Icon } from "@/components/Icon";
import { SideRow, bundleRenameMenu } from "./SidePrimitives";

export interface DetailLine {
  key: string;
  tone: "warn" | "error";
  text: string;
}

export interface DetailRow {
  key: string;
  leading?: ReactNode;
  name: string;
  hint?: string;
  hintTone?: "warn" | "error";
  count?: number;
  countTitle?: string;
  href: string;
  navState?: NavigateOptions;
  renameBundle?: string;
  title?: string;
}

/** T3x — the block that expands under the `aria-current` row (spec §5.4).
 *  Rows first, then lines. Returns `null` when both are empty, so the caller
 *  passes `detail={null}` and the row does not expand at all. */
export function SideDetail({
  rows,
  lines,
  currentPath,
}: {
  rows: DetailRow[];
  lines: DetailLine[];
  currentPath: string;
}) {
  const navigate = useNavigate();
  if (rows.length === 0 && lines.length === 0) return null;
  return (
    <>
      {rows.map((row) => (
        <SideRow
          key={row.key}
          nested
          leading={row.leading}
          name={row.name}
          hint={row.hint}
          hintTone={row.hintTone}
          count={row.count}
          countTitle={row.countTitle}
          title={row.title}
          active={currentPath === row.href}
          onClick={() => navigate(row.href, row.navState)}
          menu={row.renameBundle ? bundleRenameMenu(row.renameBundle, navigate, row.navState) : undefined}
        />
      ))}
      {lines.map((line) => (
        <div key={line.key} className="side-detail-line" data-tone={line.tone}>
          <Icon
            name={line.tone === "error" ? "state.error" : "state.update"}
            size={11}
          />
          {line.text}
        </div>
      ))}
    </>
  );
}
