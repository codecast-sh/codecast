"use client";
// In-app editor for team-editable artifacts. Teammates never receive the
// artifact's keys — source and save both flow through authed convex actions
// (sourceForWeb / editForWeb), which enforce owner-or-team-edit-mode server
// side. Owners editing their own artifacts get the richer origin editor page
// instead (ArtifactCard opens manage_url?edit=1); this modal is the keyless
// path.

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { X } from "lucide-react";
import type { ArtifactRow } from "./ArtifactCard";

import { useWatchEffect } from "../../hooks/useWatchEffect";
export function ArtifactEditModal({ artifact, onClose }: { artifact: ArtifactRow; onClose: () => void }) {
  const loadSource = useAction(api.artifactsHttp.sourceForWeb);
  const saveEdit = useAction(api.artifactsHttp.editForWeb);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useWatchEffect(() => {
    let cancelled = false;
    loadSource({ slug: artifact.slug }).then(
      (r) => {
        if (cancelled) return;
        if (r.error || r.source === undefined) setError(r.error ?? "Couldn't load source");
        else setSource(r.source);
      },
      () => !cancelled && setError("Couldn't load source"),
    );
    return () => {
      cancelled = true;
    };
  }, [artifact.slug, loadSource]);

  const publish = async () => {
    if (source === null || saving) return;
    setSaving(true);
    try {
      const r = await saveEdit({ slug: artifact.slug, content: source });
      if (r.error) {
        toast.error(r.error);
      } else if (r.unchanged) {
        toast.info("No changes to publish");
        onClose();
      } else {
        toast.success(`Published v${r.version}`);
        onClose();
      }
    } catch {
      toast.error("Publish failed");
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (dirty && !window.confirm("Discard your unpublished changes?")) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={requestClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") requestClose();
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          void publish();
        }
      }}
    >
      <div
        className="flex flex-col w-full max-w-3xl h-[80vh] rounded-lg border border-sol-border bg-sol-bg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-sol-border/50">
          <div className="min-w-0">
            <div className="text-sm font-medium text-sol-text truncate">{artifact.title}</div>
            <div className="text-[11px] text-sol-text-dim font-mono">
              editing v{artifact.version} ({artifact.kind}) · publishing mints a new version
              {artifact.mine ? "" : " credited to you"}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={publish}
              disabled={source === null || saving || !dirty}
              className="text-[13px] font-medium px-3 py-1.5 rounded bg-sol-cyan/90 text-sol-bg hover:bg-sol-cyan disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? "Publishing…" : "Publish"}
            </button>
            <button
              onClick={requestClose}
              className="p-1.5 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight"
              aria-label="Close editor"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        {error ? (
          <div className="flex-1 flex items-center justify-center text-sm text-sol-red p-8 text-center">{error}</div>
        ) : source === null ? (
          <div className="flex-1 flex items-center justify-center text-sm text-sol-text-dim">Loading source…</div>
        ) : (
          <textarea
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            className="flex-1 w-full resize-none bg-sol-bg text-sol-text font-mono text-[12.5px] leading-relaxed p-4 outline-none"
          />
        )}
      </div>
    </div>
  );
}
