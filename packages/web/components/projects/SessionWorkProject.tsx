"use client";
// The project a session works in, on its inbox card (session-projects.md SP1):
// put there, bound to its task or plan, or started by a session in it. Click
// it to filter the inbox to that project (alt excludes, shift adds), the same
// gestures its chip takes. Silent when the inbox already shows only it.
//
// The card reads `workProjectSig` inside its one tracked subscription and
// hands the string down, so the pill costs no subscription of its own.
import { workProjectChipKey, workProjectsBySession, type WorkProjectSource } from "../../store/workProjects";
import { clickProjectChip } from "../../store/chipFilterClicks";
import { projectDotClass } from "../../lib/projectColors";
import { cn } from "../../lib/utils";

const SEP = "\u0000";

type SigState = WorkProjectSource & {
  projects: Record<string, { title?: string; color?: string }>;
  activeProjectFilter?: string | null;
  chipFilterExclude?: boolean;
  extraProjectFilters?: unknown[] | null;
};

/** The card's project as one short string (id, colour, title), empty when it
 *  has none or the inbox already shows only that project. */
export function workProjectSig(s: SigState, sessionId: string): string {
  const pid = workProjectsBySession(s).get(sessionId);
  const p = pid ? s.projects[pid] : undefined;
  if (!pid || !p) return "";
  if (s.activeProjectFilter === workProjectChipKey(pid) && !s.chipFilterExclude && !s.extraProjectFilters?.length) return "";
  return [pid, p.color ?? "", p.title ?? ""].join(SEP);
}

export function SessionWorkProject({ sig, className }: { sig: string; className?: string }) {
  if (!sig) return null;
  const [pid, color, title] = sig.split(SEP);
  return (
    <>
      <span aria-hidden className="flex-shrink-0 text-[10px] text-sol-text-dim/50">·</span>
      <button
        type="button"
        data-session-work-project={pid}
        title={`In ${title}. Click to show only this project's sessions`}
        onClick={(e) => { e.stopPropagation(); clickProjectChip(workProjectChipKey(pid), null, e.altKey, e.shiftKey); }}
        className={cn("inline-flex min-w-0 max-w-[12rem] items-center gap-1 -m-0.5 p-0.5 rounded-sm text-[10px] font-medium text-sol-text-muted transition-colors hover:bg-sol-bg-highlight/60 hover:text-sol-text", className)}
      >
        <span className={cn("w-1.5 h-1.5 rotate-45 rounded-[1px] flex-shrink-0", projectDotClass({ color: color || undefined, title }))} />
        <span className="truncate">{title}</span>
      </button>
    </>
  );
}
