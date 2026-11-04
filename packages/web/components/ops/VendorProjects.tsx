"use client";
// The vendor's projects as rows to pick, in the add-source form: Sentry's
// projects in the connection's org (any number, none = every project), or one
// PostHog project. A project another source already reads says which, and a
// PostHog one cannot be picked twice. When the list cannot be read, the error
// shows and the form falls back to typing the slug or id.
import { useState } from "react";
import { useAction } from "convex/react";
import { Check, Loader2 } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useOpsScope } from "../../hooks/useSyncOps";
import type { VendorProject, VendorProjects } from "@codecast/convex/convex/sources/vendorProjects";
import "./connectSheet.css";

export function VendorProjectPicker({ provider, picked, onPick, onUnavailable }: { provider: "sentry" | "posthog"; /** Sentry: slugs; PostHog: the one id. */ picked: string[]; onPick: (next: string[]) => void; onUnavailable: (error: string) => void }) {
  const scope = useOpsScope();
  const list = useAction(api.sources.vendorProjects.listVendorProjects);
  const [answer, setAnswer] = useState<VendorProjects | null>(null);
  useWatchEffect(() => {
    if (scope === "skip") return;
    let live = true;
    list({ ...scope, provider } as any)
      .then((a: VendorProjects) => {
        if (!live) return;
        setAnswer(a);
        if (!a.ok) onUnavailable(a.error);
        // One PostHog project to read: the first nobody reads yet, so the form never submits a taken one.
        else if (provider === "posthog" && !picked.length) {
          const free = a.projects.find((p) => !p.taken_by);
          if (free) onPick([free.id]);
        }
      })
      .catch((e: any) => {
        if (!live) return;
        const error = e?.data?.message ?? e?.message ?? "Could not list projects";
        setAnswer({ ok: false, error });
        onUnavailable(error);
      });
    return () => { live = false; };
  }, [provider, scope === "skip" ? "" : JSON.stringify(scope)]);

  if (!answer) return <div className="ops-vproj" data-ops-vendor-projects="loading"><span className="ops-vproj-row ops-dim"><Loader2 className="w-3.5 h-3.5 animate-spin" />Projects</span></div>;
  if (!answer.ok) return null;
  const multi = provider === "sentry";
  const key = (p: VendorProject) => (multi ? p.slug || p.id : p.id);
  const toggle = (p: VendorProject) => {
    const k = key(p);
    if (!multi) return onPick([k]);
    onPick(picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k]);
  };
  return (
    <div className="ops-vproj" role={multi ? "group" : "radiogroup"} aria-label={`${provider === "sentry" ? "Sentry" : "PostHog"} projects`} data-ops-vendor-projects={answer.projects.length}>
      {multi && (
        <button type="button" className="ops-vproj-row" role="checkbox" aria-checked={!picked.length} onClick={() => onPick([])} data-ops-vproj="all">
          <span className="ops-vproj-box" data-on={!picked.length ? "true" : undefined}>{!picked.length && <Check className="w-3 h-3" />}</span>
          <span className="ops-vproj-name">Every project</span>
          <span className="ops-dim ops-num">{answer.projects.length}</span>
        </button>
      )}
      {answer.projects.map((p) => {
        const on = picked.includes(key(p));
        const blocked = !multi && !!p.taken_by;
        return (
          <button key={p.id} type="button" className="ops-vproj-row" role={multi ? "checkbox" : "radio"} aria-checked={on} disabled={blocked} onClick={() => toggle(p)} data-ops-vproj={key(p)}>
            <span className="ops-vproj-box" data-round={multi ? undefined : "true"} data-on={on ? "true" : undefined}>{on && <Check className="w-3 h-3" />}</span>
            <span className="ops-vproj-name truncate" title={p.name}>{p.name}</span>
            {multi && p.slug && p.slug !== p.name && <span className="ops-dim ops-mono truncate">{p.slug}</span>}
            {!multi && <span className="ops-dim ops-mono">{p.id}</span>}
            <span className="flex-1" />
            {p.taken_by && <span className="ops-tag" title={`${p.taken_by} reads this project`}>{p.taken_by}</span>}
          </button>
        );
      })}
      {!answer.projects.length && <span className="ops-vproj-row ops-dim">No projects</span>}
    </div>
  );
}
