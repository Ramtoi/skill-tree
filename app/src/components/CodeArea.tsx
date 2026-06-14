import { useMemo, type ReactNode } from "react";

// ─── Edit mode: textarea overlaid on a syntax-highlighted code block ───────
export interface CodeAreaEditProps {
  content: string;
  onChange: (value: string) => void;
  /** When true the textarea is locked; used for externally-managed skills. */
  readOnly?: boolean;
}

function highlightLine(line: string): ReactNode {
  if (/^#\s/.test(line)) return <span className="tok-h">{line}</span>;
  if (/^##\s/.test(line)) return <span className="tok-h2">{line}</span>;
  if (/^###\s/.test(line)) return <span className="tok-h2">{line}</span>;
  if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
    const lead = line.match(/^\s*(?:[-*]|\d+\.)\s/);
    return (
      <>
        <span className="tok-list">{lead ? lead[0] : ""}</span>
        {line.replace(/^\s*(?:[-*]|\d+\.)\s/, "")}
      </>
    );
  }
  if (/^\s*```/.test(line)) return <span className="tok-code">{line}</span>;

  const parts: ReactNode[] = [];
  let rest = line;
  let key = 0;
  while (rest.length) {
    const bold = rest.match(/^(.*?)\*\*([^*]+)\*\*/);
    const code = rest.match(/^(.*?)`([^`]+)`/);
    const m =
      bold && code
        ? bold[1].length <= code[1].length
          ? bold
          : code
        : bold || code;
    if (!m) {
      parts.push(rest);
      break;
    }
    parts.push(m[1]);
    if (m === bold) {
      parts.push(
        <span key={key++} className="tok-bold">
          {m[2]}
        </span>,
      );
    } else {
      parts.push(
        <span key={key++} className="tok-code">
          `{m[2]}`
        </span>,
      );
    }
    rest = rest.slice(m[0].length);
  }
  return parts;
}

export function CodeAreaEdit({ content, onChange, readOnly }: CodeAreaEditProps) {
  const lines = content.split("\n");
  return (
    <div className="code-area code-area--edit">
      {/* The inner wrapper grows with the highlighted <pre>, so the overlaid
          textarea always spans the full document and can never scroll on its
          own — .code-area stays the single scroll owner. */}
      <div className="code-area-inner">
      <pre>
        <code>
          {lines.map((line, i) => {
            const highlighted = highlightLine(line);
            const isEmpty =
              Array.isArray(highlighted) && highlighted.length === 0;
            return (
              <div key={i} style={{ minHeight: "1.55em" }}>
                <span className="ln">{i + 1}</span>
                {isEmpty || highlighted === "" ? " " : highlighted}
              </div>
            );
          })}
        </code>
      </pre>
      <textarea
        value={content}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        spellCheck={false}
      />
      </div>
    </div>
  );
}

// ─── Preview mode: ultra-light markdown renderer ──────────────────────────
type Block =
  | { mode: "p" | "list" | "code"; lines: string[] }
  | { mode: "h1" | "h2"; text: string };

export interface CodeAreaPreviewProps {
  content: string;
}

function inlineMd(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = s;
  let key = 0;
  while (rest.length) {
    const bold = rest.match(/^(.*?)\*\*([^*]+)\*\*/);
    const code = rest.match(/^(.*?)`([^`]+)`/);
    const m =
      bold && code
        ? bold[1].length <= code[1].length
          ? bold
          : code
        : bold || code;
    if (!m) {
      out.push(rest);
      break;
    }
    out.push(m[1]);
    if (m === bold) {
      out.push(<strong key={key++}>{m[2]}</strong>);
    } else {
      out.push(
        <code
          key={key++}
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--cyan)",
            background: "var(--bg-2)",
            padding: "1px 5px",
            borderRadius: 3,
            fontSize: ".92em",
          }}
        >
          {m[2]}
        </code>,
      );
    }
    rest = rest.slice(m[0].length);
  }
  return out;
}

export function CodeAreaPreview({ content }: CodeAreaPreviewProps) {
  const blocks = useMemo<Block[]>(() => {
    const lines = content.split("\n");
    const out: Block[] = [];
    let buf: string[] = [];
    let mode: "p" | "list" | "code" = "p";
    const flush = () => {
      if (buf.length === 0) return;
      out.push({ mode, lines: buf });
      buf = [];
    };
    for (const line of lines) {
      if (/^```/.test(line)) {
        if (mode === "code") {
          flush();
          mode = "p";
        } else {
          flush();
          mode = "code";
        }
        continue;
      }
      if (mode === "code") {
        buf.push(line);
        continue;
      }
      if (/^#\s/.test(line)) {
        flush();
        out.push({ mode: "h1", text: line.replace(/^#\s/, "") });
        continue;
      }
      if (/^##\s/.test(line)) {
        flush();
        out.push({ mode: "h2", text: line.replace(/^##\s/, "") });
        continue;
      }
      if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
        if (mode !== "list") {
          flush();
          mode = "list";
        }
        buf.push(line.replace(/^\s*(?:[-*]|\d+\.)\s/, ""));
        continue;
      }
      if (line.trim() === "") {
        flush();
        mode = "p";
        continue;
      }
      if (mode !== "p") {
        flush();
        mode = "p";
      }
      buf.push(line);
    }
    flush();
    return out;
  }, [content]);

  return (
    <div
      className="code-area"
      style={{
        padding: "24px 28px",
        background: "var(--bg-0)",
      }}
    >
      <div
        style={{
          maxWidth: 720,
          color: "var(--fg)",
          fontFamily: "var(--font-sans)",
          fontSize: 14,
          lineHeight: 1.65,
        }}
      >
        {blocks.map((b, i) => {
          if (b.mode === "h1") {
            return (
              <h1
                key={i}
                style={{
                  fontSize: 24,
                  fontWeight: 600,
                  color: "var(--fg-strong)",
                  margin: "24px 0 12px",
                  letterSpacing: "-0.01em",
                }}
              >
                {b.text}
              </h1>
            );
          }
          if (b.mode === "h2") {
            return (
              <h2
                key={i}
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: "var(--fg-strong)",
                  margin: "24px 0 10px",
                  textTransform: "uppercase",
                  letterSpacing: ".06em",
                }}
              >
                {b.text}
              </h2>
            );
          }
          if (b.mode === "list" && "lines" in b) {
            return (
              <ul key={i} style={{ paddingLeft: 18, margin: "8px 0" }}>
                {b.lines.map((l, j) => (
                  <li key={j} style={{ margin: "4px 0" }}>
                    {inlineMd(l)}
                  </li>
                ))}
              </ul>
            );
          }
          if (b.mode === "code" && "lines" in b) {
            return (
              <pre
                key={i}
                style={{
                  background: "var(--bg-2)",
                  padding: 14,
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  overflowX: "auto",
                  margin: "12px 0",
                }}
              >
                <code>{b.lines.join("\n")}</code>
              </pre>
            );
          }
          if ("lines" in b) {
            return (
              <p key={i} style={{ margin: "10px 0" }}>
                {inlineMd(b.lines.join(" "))}
              </p>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

// ─── Diff mode: per-line index-aligned diff ───────────────────────────────
export interface CodeAreaDiffProps {
  original: string;
  current: string;
}

export function CodeAreaDiff({ original, current }: CodeAreaDiffProps) {
  const a = original.split("\n");
  const b = current.split("\n");
  const max = Math.max(a.length, b.length);
  const rows: Array<{ kind: " " | "+" | "-"; text: string }> = [];
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) {
      rows.push({ kind: " ", text: a[i] ?? "" });
    } else {
      if (a[i] !== undefined) rows.push({ kind: "-", text: a[i] });
      if (b[i] !== undefined) rows.push({ kind: "+", text: b[i] });
    }
  }
  return (
    <div className="code-area" style={{ padding: "18px 24px" }}>
      <pre style={{ margin: 0 }}>
        <code>
          {rows.map((r, i) => (
            <div
              key={i}
              style={{
                background:
                  r.kind === "+"
                    ? "color-mix(in oklab, var(--green) 12%, transparent)"
                    : r.kind === "-"
                      ? "color-mix(in oklab, var(--red) 12%, transparent)"
                      : "transparent",
                color:
                  r.kind === "+"
                    ? "var(--green)"
                    : r.kind === "-"
                      ? "var(--red)"
                      : "var(--fg-mid)",
                padding: "0 8px",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 16,
                  color: "var(--fg-dim)",
                }}
              >
                {r.kind}
              </span>
              {r.text || " "}
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
