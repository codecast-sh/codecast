// The small pieces every priority row draws: the ten-day strip, the one
// primary action and the outlined secondary Answer, and the chips, one shape
// and icon per type so each reads in grayscale (session: pill with its state
// mark; plan: square with a target and a bar; task: a bare checkbox; PR: a
// solid tag; branch: a dashed frame in mono; deploy: a filled pill with a
// rocket). Labels are titles, never short ids; the id is in the tooltip.
import Link from "next/link";
import { Check, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, Reply, Rocket, Square, SquareCheck, Target, Workflow } from "lucide-react";
import type { PriorityPlanRef, PriorityRow, PrioritySessionState } from "@codecast/shared/contracts/priorities";
import type { NextAction } from "@codecast/shared/contracts/priorityDerive";
import type { DeployInfo } from "../../lib/priorityList";
export type { DeployInfo };
import { SessionStatusMark } from "../inbox/SessionStatusMark";
import { Button } from "../ui/button";
import { useEntityResolution } from "../../lib/entityDisplay";
import { lookup } from "../../lib/liveEntities";
import { milestoneStartHref } from "../../lib/priorities";
import { STATE_WORD, TOUCH_AREA, ago, type MilestoneModel, type SessionLine } from "../../lib/priorityList";
import type { SessionStatus } from "../../lib/sessionStatus";
import { cn } from "../../lib/utils";
import { useTrackedStore } from "../../store/inboxStore";
import { stableRefId } from "../../store/wakeSig";

const stop = (e: React.MouseEvent) => e.stopPropagation();
const NO_TASKS: string[] = [];

/** Ten days as thin bars on the page's one scale, a stub for none; today outlined; a tick over a day a critical milestone landed. */
export function DayStrip({ counts, todayIndex, landed, peak, size = "row" }: { counts: number[]; todayIndex: number; landed?: boolean[]; peak: number; size?: "row" | "mini" }) {
  const max = size === "row" ? 16 : 10;
  const top = Math.max(1, peak);
  return (
    <span data-day-strip className="flex items-end gap-px" style={{ height: max + (landed ? 5 : 0) }}>
      {counts.map((c, i) => {
        const h = c <= 0 ? 1 : Math.max(2, Math.round((Math.min(c, top) / top) * max));
        const today = i === todayIndex;
        return (
          <span key={i} className="flex flex-col items-center justify-end gap-[2px]" title={`${c} messages${today ? " today" : ""}${landed?.[i] ? " · a milestone landed" : ""}`}>
            {landed && <i className={cn("block h-[3px] w-[2px]", landed[i] ? "bg-sol-text" : "bg-transparent")} />}
            <i
              className={cn("block rounded-[1px]", size === "row" ? "w-[5px]" : "w-[3px]", today ? "border border-sol-green bg-transparent" : c > 0 ? "bg-sol-green" : "bg-sol-text/10")}
              style={{ height: today ? Math.max(4, h) : h }}
            />
          </span>
        );
      })}
    </span>
  );
}

const MARK: Record<PrioritySessionState, SessionStatus> = { needs_you: "needs_you", working: "working", dormant: "dormant", idle: "idle", done: "idle", killed: "idle" };

/** A workflow step's title as what it works on: "Review · ct-9 tidy" reads "Review: <task title>", never its id. */
function useSessionLabel(s: Pick<SessionLine, "title">): string {
  const m = /^([A-Z][A-Za-z]+) · ((?:ct|pl)-\d+)\s*(.*)$/.exec(s.title);
  const ref = useEntityResolution(m?.[2] ?? "", m ? (m[2].startsWith("pl-") ? "plan" : "task") : undefined);
  if (!m) return s.title || "Untitled session";
  const named = (ref.entity as { title?: string } | null)?.title;
  return `${m[1]}: ${named || m[3] || "work"}`;
}

/** A session: a quiet pill, its state mark and its title (a closed one says so in a word after it). */
export function SessionChip({ s, className }: { s: SessionLine; className?: string }) {
  const label = useSessionLabel(s);
  const closed = s.state === "done" || s.state === "killed";
  return (
    <Link
      href={s.href}
      onClick={stop}
      data-chip="session"
      title={`${label} · ${STATE_WORD[s.state]}`}
      className={cn("inline-flex h-6 min-w-0 max-w-[17rem] shrink items-center gap-1.5 rounded-full border border-sol-border/60 px-2 text-meta text-sol-text-muted hover:border-sol-text-dim/60 hover:text-sol-text", TOUCH_AREA, className)}
    >
      {!closed && <SessionStatusMark status={MARK[s.state]} size={12} />}
      {s.workflow && <Workflow className="size-3 shrink-0 text-sol-text-dim" aria-hidden />}
      <span className="min-w-0 truncate">{label}</span>
      {closed && <span className="shrink-0 text-sol-text-dim">closed</span>}
    </Link>
  );
}

/** A session that asks, but is not the priority's action: an outlined Answer, then its name. */
export function AnswerSecondary({ s, showName = true, tall }: { s: SessionLine; showName?: boolean; tall?: boolean }) {
  const label = useSessionLabel(s);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Link
        href={s.href}
        onClick={stop}
        data-answer="secondary"
        title={label}
        className={cn("inline-flex shrink-0 items-center gap-1 rounded-control border border-sol-text/70 font-semibold text-sol-text hover:bg-sol-text/[0.06]", tall ? "h-11 px-3 text-ui" : cn("h-6 px-2 text-meta", TOUCH_AREA))}
      >
        <Reply className="size-3" aria-hidden /> Answer
      </Link>
      {showName && <span className="min-w-0 truncate text-meta text-sol-text-dim">{label}</span>}
    </span>
  );
}

/** One session on a line: Answer when it asks, else its chip. */
export function SessionSlot({ s, className }: { s: SessionLine; className?: string }) {
  return s.state === "needs_you" ? <AnswerSecondary s={s} /> : <SessionChip s={s} className={className} />;
}

const VERB = { answer: "Answer", open: "Open", resume: "Resume", start: "Start" } as const;

/**
 * The priority's one primary action, then the session it acts on as quiet
 * text. Answer has its own look (a dark fill and a reply glyph) so it reads in
 * grayscale; Start opens a composer on the milestone.
 */
export function ActionButton({ row, action, tall, showSession = true }: { row: PriorityRow; action: NextAction<MilestoneModel>; tall?: boolean; showSession?: boolean }) {
  // Start's brief names the milestone's open tasks by title: the store's task
  // rows, read again whenever one of them changes (a title, a close).
  const taskIds = action.kind === "start" ? action.milestone.tasks : NO_TASKS;
  const s = useTrackedStore([(st) => taskIds.map((id) => { const t = lookup(st.tasks, id); return t ? stableRefId(t) : 0; }).join(",")]);
  const href = action.kind === "start" ? milestoneStartHref(row, action.milestone, (id) => lookup(s.tasks, id)) : action.session!.href;
  const size = tall ? "h-11 px-4 text-ui" : TOUCH_AREA;
  return (
    // The words after the button ellipsize inside the chips cell; the button never shrinks.
    <span data-action-group className="inline-flex min-w-0 items-center gap-2">
      {action.kind === "answer" ? (
        <Link
          href={href}
          onClick={stop}
          data-action="answer"
          className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control bg-sol-text px-2.5 text-meta font-semibold text-sol-bg hover:opacity-90", size)}
        >
          <Reply className="size-3.5" aria-hidden /> Answer
        </Link>
      ) : (
        <Button asChild variant="primary" size="xs" className={cn("shrink-0", size)}>
          <Link href={href} onClick={stop} data-action={action.kind}>{VERB[action.kind]}</Link>
        </Button>
      )}
      {showSession && action.session && <InSession s={action.session} />}
    </span>
  );
}

/** "in ‹session›": where the action acts, as quiet words that ellipsize where the line is short. */
export function InSession({ s }: { s: SessionLine }) {
  const label = useSessionLabel(s);
  return <span data-in-session className="min-w-0 shrink truncate text-meta text-sol-text-dim" title={label}>in <span className="text-sol-text-muted">{label}</span></span>;
}

/**
 * A plan: square corners and a hairline, a target glyph, its title, a small bar and the count.
 * `bar={false}` on a milestone's line, where the count says the progress and the room goes to the title.
 */
export function PlanChip({ plan, prefix, showSize, bar = true, className }: { plan: PriorityPlanRef; prefix?: string; showSize?: boolean; bar?: boolean; className?: string }) {
  const pct = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;
  return (
    <Link
      href={`/plans/${plan.short_id}`}
      onClick={stop}
      data-chip="plan"
      title={`${plan.title} · ${plan.done}/${plan.total} done${plan.size > plan.total ? ` · ${plan.size} tasks` : ""}`}
      className={cn("inline-flex h-6 min-w-[6rem] max-w-[15rem] shrink items-center gap-1.5 rounded-[3px] border border-sol-border px-1.5 text-meta text-sol-text hover:border-sol-text-dim/60", TOUCH_AREA, className)}
    >
      <Target className="size-3 shrink-0 text-sol-text-dim" aria-hidden />
      {prefix && <span className="shrink-0 text-sol-text-dim">{prefix}</span>}
      {/* A "Part of" chip keeps 6rem for the title: in a narrow row (a phone) the bar leaves first, then "(N tasks)". */}
      <span data-plan-title className={cn("min-w-0 truncate", showSize && "min-w-[6rem]")}>{plan.title}</span>
      {bar && (
        <span aria-hidden data-plan-bar className={cn("relative block h-[3px] w-6 shrink-0 overflow-hidden rounded-full bg-sol-text/15", showSize && "[@container(max-width:24rem)]:hidden")}>
          <span className="absolute inset-y-0 left-0 bg-sol-text-muted" style={{ width: `${pct}%` }} />
        </span>
      )}
      <span className="shrink-0 tabular-nums text-sol-text-dim">{plan.done}/{plan.total}</span>
      {/* A big plan a milestone is part of says how big, inside its chip: "Part of Platform program (140 tasks)". */}
      {showSize && <span data-plan-size className="shrink-0 tabular-nums text-sol-text-dim [@container(max-width:17rem)]:hidden">({plan.size} tasks)</span>}
    </Link>
  );
}

/** A task: no frame, a checkbox and its title. */
export function TaskChip({ id, className }: { id: string; className?: string }) {
  const r = useEntityResolution(id, "task");
  const task = r.entity as { title?: string; status?: string } | null;
  const done = task?.status === "done";
  const Box = done ? SquareCheck : Square;
  return (
    <Link href={`/tasks/${id}`} onClick={stop} data-chip="task" title={task?.title ?? "Task"} className={cn("inline-flex h-6 min-w-[5rem] max-w-[14rem] shrink items-center gap-1 px-0.5 text-meta text-sol-text hover:underline decoration-sol-text-dim/50", TOUCH_AREA, done && "text-sol-text-muted", className)}>
      <Box className="size-3.5 shrink-0 text-sol-text-dim" aria-hidden />
      <span className="min-w-0 truncate">{task?.title || "Task"}</span>
    </Link>
  );
}

const PR_ICON = { open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed } as const;

/** A pull request: a solid-edged tag, the glyph for its state, its number and the state in words. */
export function PrChip({ pr, state }: { pr: string; state?: string }) {
  const [repo, number] = pr.split("#");
  const st = state === "merged" ? "merged" : state === "closed" ? "closed" : "open";
  const Icon = PR_ICON[st];
  return (
    <a href={`https://github.com/${repo}/pull/${number}`} target="_blank" rel="noreferrer" onClick={stop} data-chip="pr" title={pr}
      className={cn("inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[5px] border-[1.5px] border-sol-border bg-sol-bg px-1.5 text-meta tabular-nums text-sol-text", TOUCH_AREA)}>
      <Icon className="size-3 text-sol-text-muted" aria-hidden /><span className="font-mono">#{number}</span>{state && <span className="text-sol-text-dim">{st}</span>}
    </a>
  );
}

export type LinkKind = "task" | "pr" | "branch" | "deploy";
const KIND_COUNT: Record<LinkKind, { Icon: typeof Square; one: string; many: string }> = {
  task: { Icon: Square, one: "task", many: "tasks" },
  pr: { Icon: GitPullRequest, one: "pull request", many: "pull requests" },
  branch: { Icon: GitBranch, one: "branch", many: "branches" },
  deploy: { Icon: Rocket, one: "deploy", many: "deploys" },
};

/** How many links of one kind a closed line has, as its glyph and a count (the words in its tooltip): the open line lists them. */
export function KindCount({ kind, n }: { kind: LinkKind; n: number }) {
  const { Icon, one, many } = KIND_COUNT[kind];
  const words = `${n} ${n === 1 ? one : many}`;
  return (
    <span data-chip-count={kind} title={words} aria-label={words} className="inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-sol-text/[0.05] px-1.5 text-meta tabular-nums text-sol-text-muted">
      <Icon className="size-3 shrink-0" aria-hidden />{n}
    </span>
  );
}

/** A branch: a dashed frame, the branch glyph, its name in mono. */
export function BranchChip({ name }: { name: string }) {
  return (
    <span data-chip="branch" title={name} className="inline-flex h-[22px] min-w-[5rem] max-w-[13rem] shrink items-center gap-1 rounded-[3px] border border-dashed border-sol-text-dim/60 px-1.5 font-mono text-mark text-sol-text-muted">
      <GitBranch className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}


/** A deploy: a filled pill, a rocket, where it went and how long ago. */
export function DeployChip({ d, now }: { d: DeployInfo; now: number }) {
  return (
    <Link href="/deploys" onClick={stop} data-chip="deploy" title={`${d.target} · ${d.status}`} className={cn("inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-sol-text/[0.07] px-2 text-meta text-sol-text hover:bg-sol-text/[0.12]", TOUCH_AREA)}>
      <Rocket className={cn("size-3", d.status === "live" ? "text-sol-green" : d.status === "failed" ? "text-sol-red" : "text-sol-text-muted")} aria-hidden />
      <span>{d.target}</span>
      {/* Not live: the state in words, so it reads in grayscale. */}
      {d.status !== "live" && <span data-deploy-state className="text-sol-text-muted">{d.status}</span>}
      <span className="tabular-nums text-sol-text-dim">{ago(d.at, now)}</span>
    </Link>
  );
}

/**
 * A teammate's milestone: a status mark, not a box, since nothing here is
 * theirs to press. Open is a hollow ring, done a check; each says so.
 */
export function MilestoneMark({ done }: { done: boolean }) {
  return (
    <span data-milestone-mark={done ? "done" : "open"} role="img" aria-label={done ? "Done" : "Open"} title={done ? "Done" : "Open"} className="flex size-[14px] shrink-0 items-center justify-center">
      {done
        ? <Check className="size-3.5 text-sol-green" strokeWidth={2.5} aria-hidden />
        : <span aria-hidden className="block size-[8px] rounded-full border-[1.5px] border-sol-text-dim" />}
    </span>
  );
}

/** A milestone: a square checkbox, empty or checked. */
export function MilestoneBox({ done }: { done: boolean }) {
  return done
    ? <span aria-label="Done" className="flex size-[14px] shrink-0 items-center justify-center rounded-[3px] bg-sol-green text-sol-bg"><svg viewBox="0 0 10 10" className="size-[10px]" aria-hidden><path d="M2 5.2 4.1 7.3 8 3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
    : <span aria-label="Open" className="block size-[14px] shrink-0 rounded-[3px] border-[1.5px] border-sol-text-dim" />;
}
