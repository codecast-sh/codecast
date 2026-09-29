"use client";
// Resetting the org (docs/architecture/org-staffing.md S27): every role is
// retired with its triggers, its sessions go back to their owners, and every
// proposal is archived, so the next review starts from the work alone. It
// lives at the foot of History, the record and the way back, and asks first:
// the confirm reads what a reset would change from the server (a dry run)
// and says it in plain words before anything moves.
import { useCallback, useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { RoleFace } from "./RoleFace";

export type OrgResetPreview = { roles: Array<{ short_id: string; handle: string; name: string; sessions: number }>; proposals: number };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const serverLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\[Request ID: [^\]]+\] Server Error\s*/i, "").replace(/^Uncaught Error:\s*/i, "").split("\n")[0].trim();

/** What a reset would change, as the sentences the confirm shows. */
export function resetSentences(p: OrgResetPreview): string[] {
  const sessions = p.roles.reduce((n, r) => n + r.sessions, 0);
  if (p.roles.length === 0 && p.proposals === 0) return ["There is nothing to reset: this workspace has no roles and no proposals."];
  return [
    p.roles.length > 0 ? `${count(p.roles.length, "role is", "roles are")} retired, and ${p.roles.length === 1 ? "its" : "their"} triggers are cancelled.` : "",
    sessions > 0 ? `${count(sessions, "session goes", "sessions go")} back to ${sessions === 1 ? "its owner" : "their owners"}.` : "",
    p.proposals > 0 ? `${count(p.proposals, "proposal is", "proposals are")} archived, open ones included.` : "",
    "Your projects, plans, tasks and sessions stay as they are. The next review starts from the work alone.",
  ].filter(Boolean);
}

export function OrgReset({ preview, reset, onDone }: {
  /** Reads what a reset would change; changes nothing. */
  preview: () => Promise<OrgResetPreview>;
  reset: () => Promise<unknown>;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<OrgResetPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const read = useCallback(() => {
    setPlan(null); setProblem(null);
    preview().then(setPlan, (e) => setProblem(serverLine(e) || "Could not read what a reset would change."));
  }, [preview]);
  const confirm = async () => {
    setBusy(true);
    try {
      await reset();
      toast.success("The org was reset");
      setOpen(false);
      onDone?.();
    } catch (e) {
      setProblem(serverLine(e) || "The reset did not go through.");
    } finally { setBusy(false); }
  };
  const nothing = !!plan && plan.roles.length === 0 && plan.proposals === 0;
  return (
    <div className="mt-8 pt-4 border-t" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }} data-org-reset>
      <p className="text-[12px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>Start over: retire every role and archive every proposal, so the next review starts from the work alone.</p>
      <button type="button" onClick={() => { setOpen(true); read(); }} className="mt-2 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium hover:bg-sol-red/10" style={{ color: "var(--sol-red)" }} data-org-reset-open>
        <RotateCcw className="w-3.5 h-3.5" /> Reset the org…
      </button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="max-w-[460px] grid-cols-1" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-red) 35%, transparent)" }} data-org-reset-dialog>
          <DialogHeader>
            <DialogTitle className="text-[17px]" style={{ fontFamily: "var(--font-serif)" }}>Reset the org?</DialogTitle>
            <DialogDescription className="text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>
              This cannot be undone from History.
            </DialogDescription>
          </DialogHeader>
          {!plan && !problem && <p className="text-[12.5px]" style={{ color: "var(--sol-text-dim)" }} aria-busy>Reading what a reset would change…</p>}
          {problem && <p role="alert" className="text-[12.5px]" style={{ color: "var(--sol-red)" }} data-org-reset-problem>{problem}</p>}
          {plan && (
            <div className="flex flex-col gap-2.5" data-org-reset-plan>
              {plan.roles.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" data-org-reset-roles={plan.roles.length}>
                  {plan.roles.map((r) => (
                    <li key={r.short_id} className="inline-flex items-center gap-1.5 h-7 pl-1 pr-2 rounded-full border text-[12px]" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", color: "var(--sol-text)" }}>
                      <RoleFace role={r} size={20} />{r.name}
                    </li>
                  ))}
                </ul>
              )}
              <ul className="flex flex-col gap-1 text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }}>
                {resetSentences(plan).map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={() => setOpen(false)} disabled={busy} className="h-8 px-3 rounded-lg text-[12.5px] hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-muted)" }}>{nothing ? "Close" : "Cancel"}</button>
            {!nothing && (
              <button type="button" onClick={confirm} disabled={!plan || busy} className="h-8 px-3.5 rounded-lg text-[12.5px] font-semibold disabled:opacity-50" style={{ background: "var(--sol-red)", color: "var(--sol-bg)" }} data-org-reset-confirm>
                {busy ? "Resetting…" : "Reset the org"}
              </button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
