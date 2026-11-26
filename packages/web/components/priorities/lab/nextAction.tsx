// Priorities lab (throwaway prototype): what to do next on a priority, one
// function for every surface (the list, the reference card, the priority's
// own page), and the button it draws.
import Link from "next/link";
import { CornerDownRight, Play, RotateCcw } from "lucide-react";
import type { PriorityRow, PriorityStep } from "@codecast/shared/contracts/priorities";
import { newSessionHref } from "../../../lib/priorities";
import { cn } from "../../../lib/utils";
import { StateMark } from "./LabParts";
import { bestOf, type SessionView } from "./labModel";
import type { MilestoneModel, PriorityModel } from "./PriorityBlock";

/** needs_you: open the session asking; working: it is moving; resume: a person's quiet session; start: nothing live. */
export type NextKind = "needs_you" | "working" | "resume" | "start";
export type NextAction = { m: MilestoneModel; session?: SessionView; kind: NextKind };

/** The priority's next milestone: its first open critical one, in milestone order, and what to press on it. */
export function nextOf(model: PriorityModel): NextAction | null {
  const m = model.milestones.find((x) => !x.step.done && x.step.tier === "critical");
  if (!m) return null;
  const session = bestOf(m.sessions);
  if (!session) return { m, kind: "start" };
  const st = session.status;
  if (st === "needs_you" || st === "error") return { m, session, kind: "needs_you" };
  if (st === "working" || st === "starting") return { m, session, kind: "working" };
  return { m, session, kind: "resume" };
}

/** The one page-level "Next": nothing is moving, asking or parked on it, so it is the viewer's to pick up. */
export function isPickUp(a: NextAction | null): boolean {
  return !!a && (a.kind === "start" || (a.kind === "resume" && a.session?.status !== "dormant"));
}

const BTN = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-meta font-semibold";

/** The action line's button. Start opens a composer seeded with the milestone's brief, so it is one press. */
export function ActionButton({ row, step, action, className }: { row: PriorityRow; step: PriorityStep; action: NextAction; className?: string }) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (action.kind === "start") {
    return (
      <Link href={newSessionHref(row, step)} onClick={stop} title="Open a new session on this milestone, its brief filled in" className={cn(BTN, "bg-sol-text/[0.09] text-sol-text hover:bg-sol-text/[0.14]", className)}>
        <Play className="size-3 fill-current" /> Start
      </Link>
    );
  }
  const s = action.session!;
  if (action.kind === "needs_you") {
    return (
      <Link href={s.href} onClick={stop} title={s.title} className={cn(BTN, "border border-sol-yellow/60 bg-sol-yellow/15 text-sol-text hover:bg-sol-yellow/25", className)}>
        <StateMark status={s.status} size={12} /> Open · Needs you
      </Link>
    );
  }
  if (action.kind === "resume") {
    return (
      <Link href={s.href} onClick={stop} title={s.title} className={cn(BTN, "bg-sol-text/[0.09] text-sol-text hover:bg-sol-text/[0.14]", className)}>
        <RotateCcw className="size-3" /> Resume
      </Link>
    );
  }
  return (
    <Link href={s.href} onClick={stop} title={s.title} className={cn(BTN, "border border-sol-border text-sol-text-muted hover:text-sol-text", className)}>
      <CornerDownRight className="size-3" /> Open
    </Link>
  );
}
