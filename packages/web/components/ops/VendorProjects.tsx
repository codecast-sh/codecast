"use client";
// The vendor's projects as rows to pick, in the add-source form: Sentry's
// projects in the connection's org (any number, none = every project), or one
// PostHog project. A project another source already reads says which, and a
// PostHog one cannot be picked twice. When the list cannot be read, the error
// shows and the form falls back to typing the slug or id.
import { Check, Loader2 } from "lucide-react";
import type { VendorProject } from "@codecast/convex/convex/sources/vendorProjects";
import { useVendorProjects } from "./useVendorProjects";
import "./connectSheet.css";

/** Nothing starts picked: a PostHog source reads the project a person chose, never the list's first. */
export function VendorProjectPicker({ provider, picked, onPick, onUnavailable }: { provider: "sentry" | "posthog"; /** Sentry: slugs; PostHog: the one id. */ picked: string[]; onPick: (next: string[], projects: VendorProject[]) => void; onUnavailable: (error: string) => void }) {
  const answer = useVendorProjects(provider, (a) => { if (!a.ok) onUnavailable(a.error); });

  if (!answer) return <div className="ops-vproj" data-ops-vendor-projects="loading"><span className="ops-vproj-row ops-dim"><Loader2 className="w-3.5 h-3.5 animate-spin" />Projects</span></div>;
  if (!answer.ok) return null;
  const multi = provider === "sentry";
  const key = (p: VendorProject) => (multi ? p.slug || p.id : p.id);
  const toggle = (p: VendorProject) => {
    const k = key(p);
    const next = !multi ? [k] : picked.includes(k) ? picked.filter((x) => x !== k) : [...picked, k];
    onPick(next, answer.projects.filter((x) => next.includes(key(x))));
  };
  const counted = answer.projects.some((p) => p.events_7d !== undefined);
  return (
    <div className="ops-vproj" role={multi ? "group" : "radiogroup"} aria-label={`${provider === "sentry" ? "Sentry" : "PostHog"} projects`} data-ops-vendor-projects={answer.projects.length}>
      {counted && <div className="ops-vproj-head" aria-hidden><span>Project</span><span>Events, 7d</span></div>}
      {multi && (
        <button type="button" className="ops-vproj-row" role="checkbox" aria-checked={!picked.length} onClick={() => onPick([], [])} data-ops-vproj="all">
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
            <span className="flex-1" />
            {counted && <span className="ops-num ops-vproj-n" data-zero={!p.events_7d ? "true" : undefined} title={p.events_7d !== undefined ? `${p.events_7d.toLocaleString()} events in the last 7 days · project ${p.id}` : `project ${p.id}`}>{p.events_7d !== undefined ? compactCount(p.events_7d) : "–"}</span>}
            {!multi && !counted && <span className="ops-dim ops-mono">{p.id}</span>}
            {p.taken_by && <span className="ops-tag" title={`${p.taken_by} reads this project`}>{p.taken_by}</span>}
          </button>
        );
      })}
      {!answer.projects.length && <span className="ops-vproj-row ops-dim">No projects</span>}
    </div>
  );
}

function compactCount(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString();
}
