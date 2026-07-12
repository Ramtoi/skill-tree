import { useEffect, useState } from "react";
import { invoke } from "@/lib/ipc";
import { useNavigate } from "react-router-dom";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "./Toast";
import { Button } from "./Button";
import { Field, MetaGrid } from "./Field";
import { IconPicker } from "./IconPicker";
import { Kbd } from "./Kbd";
import type { BundleScope } from "@/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function NewBundleSheet({ open, onClose }: Props) {
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("📦");
  const [scope, setScope] = useState<BundleScope>("project-specific");
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
      setDescription("");
      setIcon("📦");
      setScope("project-specific");
      setLoading(false);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setLoading(true);
    try {
      // Always pass --skills (argparse marks it required); an empty value
      // creates an empty bundle — skills are added afterwards in BundleManager.
      const args = ["bundle", "new", trimmed, "--skills", ""];
      if (description.trim()) args.push("--description", description.trim());
      if (icon.trim()) args.push("--icon", icon.trim());
      args.push("--scope", scope);
      const result = await invoke<{ success: boolean; output: string }>("hub_cmd", {
        args,
      });
      if (!result.success) throw new Error(result.output);
      await queryClient.invalidateQueries({ queryKey: ["registry"] });
      toast.success(`Bundle "${trimmed}" created`);
      onClose();
      navigate(`/bundle/${encodeURIComponent(trimmed)}`);
    } catch (err) {
      toast.error("Couldn't create bundle", String(err));
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
            New bundle
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
                placeholder="my-bundle-name"
                pattern="[a-z0-9-]+"
                required
              />
            </Field>
            <Field label="icon" full>
              <IconPicker value={icon} onChange={setIcon} />
            </Field>
            <Field label="scope">
              <select value={scope} onChange={(e) => setScope(e.target.value as BundleScope)}>
                <option value="project-specific">project-specific</option>
                <option value="global">global</option>
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
              {loading ? "Creating…" : "Create bundle"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
