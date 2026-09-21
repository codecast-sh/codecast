"use client";
// The sentence a person reads before a role gains scope, and the one edit
// that goes with it (org-roles-run-work.md R1): "12 sessions now report to
// @growth and leave your needs input" and "Leave the sessions where they
// are". One component, so the proposal's rows and asks, the scope editor in
// Settings, the lead chip and the hire form say it the same way.
import { useRef, useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import { cn } from "../../lib/utils";
import { useTakeoverPreviews, type TakeoverAsk } from "../../hooks/useTakeoverPreviews";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { OrgButton } from "./OrgButton";
import { LEAVE_SESSIONS_LABEL } from "../../lib/takeoverLabels";

export function TakeoverEdit({ phrase, leave, onLeave, className }: {
  /** takeoverPhrase's sentence, from useTakeoverPreviews. */
  phrase: string;
  leave: boolean;
  onLeave: (leave: boolean) => void;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border px-2 py-1.5 text-[11.5px] leading-snug", className)} style={{ borderColor: "color-mix(in srgb, var(--sol-yellow) 40%, transparent)", background: "color-mix(in srgb, var(--sol-yellow) 8%, transparent)" }} data-takeover data-takeover-leave={leave ? "1" : "0"}>
      <p className={cn("flex items-start gap-1.5", leave && "line-through opacity-60")} style={{ color: "var(--sol-text-secondary)" }} data-takeover-phrase>
        <ArrowRightLeft className="w-3 h-3 shrink-0 mt-[2px]" style={{ color: "var(--sol-yellow)" }} />
        <span className="min-w-0">{phrase}.</span>
      </p>
      <label className="mt-1 flex items-center gap-1.5 cursor-pointer select-none" style={{ color: "var(--sol-text)" }}>
        <input type="checkbox" checked={leave} onChange={(e) => onLeave(e.target.checked)} className="w-3 h-3 accent-[var(--sol-violet)]" data-takeover-leave-input />
        {LEAVE_SESSIONS_LABEL}
      </label>
    </div>
  );
}

/**
 * A scope gain made by hand (the scope editor in Settings, a project's lead):
 * the write waits here until the server has counted what it moves. Nothing to
 * move: it confirms itself at once, so an edit that takes no session over
 * costs the person nothing. Something to move: the sentence, the one edit,
 * and the button. The surface paints its pending change itself; this only
 * holds the write, because a takeover of a hundred sessions is not something
 * an undo puts back.
 */
export function TakeoverGate({ workspace, ask, what, confirmLabel, onConfirm, onCancel, className }: {
  workspace: { kind: "team" | "user"; id: string } | null | undefined;
  /** The role and the refs its scope gains. */
  ask: Omit<TakeoverAsk, "key">;
  /** What is about to happen, in the surface's words: "Add Growth to what @growth looks after". */
  what: string;
  confirmLabel: string;
  onConfirm: (opts: { leave_sessions: boolean }) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [leave, setLeave] = useState(false);
  const { byKey, ready } = useTakeoverPreviews(workspace, [{ key: "gate", ...ask }]);
  const preview = byKey.gate;
  const fired = useRef(false);
  const confirm = (leave_sessions: boolean) => { if (fired.current) return; fired.current = true; onConfirm({ leave_sessions }); };
  useWatchEffect(() => { if (ready && !preview) confirm(false); }, [ready, preview]);
  if (ready && !preview) return null;
  return (
    <div className={cn("rounded-lg border p-2 flex flex-col gap-1.5 org-pop-in", className)} style={{ borderColor: "color-mix(in srgb, var(--sol-violet) 35%, transparent)", background: "var(--sol-card)" }} data-takeover-gate={ready ? "ready" : "counting"}>
      <p className="text-[12px] leading-snug" style={{ color: "var(--sol-text)" }}>{what}</p>
      {preview
        ? <TakeoverEdit phrase={preview.phrase} leave={leave} onLeave={setLeave} />
        : <p className="text-[11.5px]" style={{ color: "var(--sol-text-dim)" }} data-takeover-counting>Counting the sessions this moves</p>}
      <div className="flex items-center gap-1.5">
        <OrgButton primary size="sm" disabled={!ready} onClick={() => confirm(leave)} data-takeover-confirm>{confirmLabel}</OrgButton>
        <OrgButton size="sm" onClick={onCancel} data-takeover-cancel>Cancel</OrgButton>
      </div>
    </div>
  );
}
