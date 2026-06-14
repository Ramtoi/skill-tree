import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "./Toast";
import { Button } from "./Button";
import { Field, MetaGrid } from "./Field";
import { Kbd } from "./Kbd";
import type { SkillType, SkillScope } from "@/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function NewSkillSheet({ open, onClose }: Props) {
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [type, setType] = useState<SkillType>("claude-skill");
  const [scope, setScope] = useState<SkillScope>("global");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setName("");
      setType("claude-skill");
      setScope("global");
      setDescription("");
      setLoading(false);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      const kind = type === "mcp-server" ? "mcp" : "skill";
      const result = await invoke<{ success: boolean; output: string }>("hub_cmd", {
        args: [
          "new",
          kind,
          name.trim(),
          "--type",
          type,
          "--scope",
          scope,
          "--description",
          description.trim(),
        ],
      });
      if (!result.success) throw new Error(result.output);
      await queryClient.invalidateQueries({ queryKey: ["registry"] });
      toast.success(`Skill "${name}" created`);
      onClose();
      navigate(`/skill/${encodeURIComponent(name.trim())}`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(480px, 92vw)", maxHeight: "unset" }}
      >
        <div className="palette-head">
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-strong)" }}>
            New skill
          </span>
          <span style={{ marginLeft: "auto" }}>
            <Kbd>esc</Kbd>
          </span>
        </div>
        <form onSubmit={handleSubmit} style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <MetaGrid>
            <Field label="name" full>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-skill-name"
                pattern="[a-z0-9-]+"
                required
              />
            </Field>
            <Field label="type">
              <select value={type} onChange={(e) => setType(e.target.value as SkillType)}>
                <option value="claude-skill">SKILL</option>
                <option value="mcp-server">MCP</option>
              </select>
            </Field>
            <Field label="scope">
              <select value={scope} onChange={(e) => setScope(e.target.value as SkillScope)}>
                <option value="global">global</option>
                <option value="portable">portable</option>
                <option value="project-specific">project-specific</option>
              </select>
            </Field>
            <Field label="description" full>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One-line description…"
                rows={2}
              />
            </Field>
          </MetaGrid>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button onClick={onClose} type="button">
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="check"
              type="submit"
              disabled={loading || !name.trim()}
            >
              {loading ? "Creating…" : "Create skill"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
