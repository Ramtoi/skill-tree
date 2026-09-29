import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  bundleWriteLanded,
  errText,
  runRegistryWrite,
  showBundleWarnings,
  type BundleCmdPayload,
} from "@/lib/hubWrite";
import { invalidateRegistry } from "@/lib/invalidate";
import { trackProcess } from "@/lib/trackProcess";
import { useToast } from "./Toast";
import { Sheet } from "./Modal";
import { Button } from "./Button";
import { Field } from "./Field";
import { ChipRadios } from "./ChipRadios";
import { Icon } from "./Icon";
import { SCOPE_INTENT_NOTE, SCOPE_REACH, scopeKey } from "./Tag";
import { IconField } from "./emoji/IconField";
import type { BundleScope } from "@/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function NewBundleSheet({ open, onClose }: Props) {
  const navigate = useNavigate();
  const toast = useToast();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("📦");
  const [scope, setScope] = useState<BundleScope>("portable");
  const [loading, setLoading] = useState(false);

  // Reset on open
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setIcon("📦");
      setScope("portable");
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
      // creates an empty bundle — skills are added afterwards via the bundle
      // lens's "Add skills" control.
      const args = ["bundle", "new", trimmed, "--skills", ""];
      if (description.trim()) args.push("--description", description.trim());
      if (icon.trim()) args.push("--icon", icon.trim());
      args.push("--scope", scope, "--json");
      // The bundle is written before the auto-sync runs: a doctor danger
      // finding is a warning about the sync, not a failed creation. The write
      // and its auto-sync run in one process, so the dialog stays open for
      // the whole call — trackProcess reports the wait through the status bar
      // and process tray while it does.
      const { payload, warning } = await trackProcess(
        {
          title: `Creating bundle ${trimmed}`,
          body: "writing bundle · syncing projects",
          kind: "local",
          target: `bundle-new:${trimmed}`,
        },
        () => runRegistryWrite<BundleCmdPayload>(args, bundleWriteLanded),
        { successBody: `${trimmed} created` },
      );
      await invalidateRegistry();
      toast.success(`Bundle "${trimmed}" created`);
      showBundleWarnings(toast, payload);
      if (warning) toast.info("Sync reported findings", warning);
      onClose();
      navigate(`/bundle/${encodeURIComponent(trimmed)}`);
    } catch (err) {
      toast.error("Couldn't create bundle", errText(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      side="center"
      width={480}
      title="New bundle"
      initialFocus={nameRef}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="check"
            type="submit"
            form="new-bundle-form"
            disabled={loading || !name.trim()}
          >
            {loading ? "Creating…" : "Create bundle"}
          </Button>
        </>
      }
    >
      <form id="new-bundle-form" className="modal-form" onSubmit={handleSubmit}>
        <div className="bundle-identity">
          <Field label="icon" htmlFor="new-bundle-icon">
            <IconField id="new-bundle-icon" value={icon} onChange={setIcon} />
          </Field>
          <Field label="name" hint="Lowercase letters, digits and dashes">
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-bundle-name"
              pattern="[a-z0-9\-]+"
              required
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </div>
        <Field
          label="scope"
          full
          className="bundle-scope-field"
          hint={
            <>
              {SCOPE_REACH[scopeKey(scope)]}
              {scopeKey(scope) !== "global" && ` · ${SCOPE_INTENT_NOTE}`}
            </>
          }
        >
          <ChipRadios
            name="bundle-scope"
            label="Scope"
            value={scope}
            onChange={setScope}
            options={[
              {
                value: "portable",
                label: "portable",
                icon: <Icon name="loadout" size={13} />,
                title: SCOPE_REACH.portable,
              },
              {
                value: "project-specific",
                label: "project",
                icon: <Icon name="project" size={13} />,
                title: SCOPE_REACH.project,
              },
              {
                value: "global",
                label: "global",
                icon: <Icon name="globe" size={13} />,
                title: SCOPE_REACH.global,
              },
            ]}
          />
        </Field>
        <Field label="description" full>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One-line description…"
            rows={2}
          />
        </Field>
      </form>
    </Sheet>
  );
}
