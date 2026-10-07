"use client";
// What the org screen says about the tree read when there is no tree to
// draw (orgReadState.ts): the function not deployed, a failed read, a
// refusal, nothing yet, nobody in it. One block, mounted in whichever column
// has nothing else to show, and the one-line banner for a stale copy.
import { Network } from "lucide-react";
import { OrgButton } from "./OrgButton";
import type { OrgTreeReadState } from "./orgReadState";

export type OrgReadBlockKind = Exclude<OrgTreeReadState["kind"], "ok" | "stale">;

export function OrgReadStateBlock({ kind, message, onRetry }: { kind: OrgReadBlockKind; message?: string; onRetry?: () => void }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center" data-org-read={kind}>
      {kind === "missing" ? (
        <div className="text-center max-w-xs px-6">
          <Network className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--sol-text-dim)" }} />
          <div className="text-sm font-medium">Nothing to show yet</div>
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--sol-text-muted)" }}>The chart appears here on its own when it is ready.</p>
        </div>
      ) : kind === "error" ? (
        // A read that failed is said as one, with the server's own
        // sentence: an empty chart or an endless skeleton would read
        // as "nobody works here".
        <div className="text-center max-w-sm px-6">
          <Network className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--sol-red)" }} />
          <div className="text-sm font-medium">The org chart could not be read</div>
          <p className="mt-1 text-[12.5px] break-words" style={{ color: "var(--sol-text-muted)" }}>{message}</p>
          {onRetry && <div className="mt-3 flex justify-center"><OrgButton size="sm" onClick={onRetry}>Try again</OrgButton></div>}
        </div>
      ) : kind === "refused" ? (
        <div className="text-center max-w-xs px-6">
          <Network className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--sol-orange)" }} />
          <div className="text-sm font-medium">You cannot read this workspace's org chart</div>
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--sol-text-muted)" }}>You may have left the team, or the workspace was removed. Switch workspace from the menu at the top left.</p>
        </div>
      ) : kind === "loading" ? (
        <div className="flex flex-col items-center gap-3" style={{ color: "var(--sol-text-dim)" }}>
          <Network className="w-8 h-8 animate-pulse" style={{ color: "var(--sol-violet)" }} />
          <span className="text-sm">Drawing the tree…</span>
        </div>
      ) : (
        <div className="text-center max-w-xs px-6">
          <div className="text-sm font-medium">Nobody here yet</div>
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--sol-text-muted)" }}>Sessions from the last 30 days appear under their owners.</p>
        </div>
      )}
    </div>
  );
}

/** The dev preview (`?preview=1`): said once, under the header. */
export function OrgPreviewBanner() {
  return (
    <div className="shrink-0 px-4 sm:px-6 py-1.5 text-[11.5px] flex items-center gap-2 border-b" data-org-preview-banner style={{ background: "color-mix(in srgb, var(--sol-yellow) 8%, transparent)", borderColor: "color-mix(in srgb, var(--sol-yellow) 25%, transparent)", color: "var(--sol-text-muted)" }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--sol-yellow)" }} />
      Preview data (dev only, ?preview=1). Edits here stay on this page.
    </div>
  );
}

/** The read failed but a cached tree paints: said above both columns. */
export function OrgStaleBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="shrink-0 px-4 sm:px-6 py-1.5 text-[11.5px] flex items-center gap-2 border-b" data-org-read="stale" style={{ background: "color-mix(in srgb, var(--sol-red) 7%, transparent)", borderColor: "color-mix(in srgb, var(--sol-red) 25%, transparent)", color: "var(--sol-text-muted)" }}>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "var(--sol-red)" }} />
      <span className="min-w-0 flex-1 truncate" title={message}>The chart could not be refreshed, so this is the last copy: {message}</span>
      <button type="button" onClick={onRetry} className="shrink-0 underline-offset-2 hover:underline" style={{ color: "var(--sol-violet)" }}>Try again</button>
    </div>
  );
}
