import type React from "react";
import Link from "next/link";
import { CircleCheck, CircleHelp, CheckCheck, GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { entityRoute } from "@codecast/shared/entities";
import { AvatarImg } from "../../lib/avatarCache";
import { cn, formatDateFull } from "../../lib/utils";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { badgeVariants } from "../ui/badge";
import { AVATAR_BG, hashIndex, relTime } from "../feed/activityFeedFormat";
import type { ExternalEventAccent } from "../../lib/externalEvents";
import type { ActivityActor, ActivityDecision, ActivityPr, ActivityTask } from "./activityModel";

// The Activity page's small pieces: a person's face, the outcome chips (a pull
// request in its state's colour, a task, a decision) and a row's time. Every
// chip is a link to the thing it names. A chip is the Badge tone in every
// style; Classic and Minimal take Modern's 20px shape on their own 4px corner
// (Badge's Classic face is a roomier label).

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

type BadgeTone = "green" | "red" | "yellow" | "blue" | "violet" | "cyan" | "magenta" | "orange" | "neutral";
const TONE_OF_ACCENT: Record<ExternalEventAccent, BadgeTone> = {
  green: "green", red: "red", yellow: "yellow", blue: "blue", violet: "violet", cyan: "cyan", magenta: "magenta", orange: "orange", muted: "neutral",
};
const chip = (tone: BadgeTone) =>
  cn(badgeVariants({ variant: tone }), "h-5 gap-1 whitespace-nowrap rounded px-1.5 text-meta font-medium min-w-0 max-w-[18rem] overflow-hidden transition-opacity hover:opacity-80");

/** A person's face: their avatar, else their initial on a tint of their own. */
export function Face({ actor, size = 20, className = "" }: { actor: ActivityActor; size?: number; className?: string }) {
  const initial = (actor.name || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span aria-hidden className={`inline-flex shrink-0 overflow-hidden rounded-full ${className}`} style={{ width: size, height: size }}>
      <AvatarImg
        src={actor.image}
        alt=""
        className="h-full w-full object-cover"
        fallback={
          <span className={`flex h-full w-full items-center justify-center font-semibold ${AVATAR_BG[hashIndex(actor.id, AVATAR_BG.length)]}`} style={{ fontSize: Math.max(11, Math.round(size * 0.5)) }}>
            {initial}
          </span>
        }
      />
    </span>
  );
}

/** A pull request: its number and state in the state's colour, the title when there is room. */
export function PrChip({ pr, withTitle = false }: { pr: ActivityPr; withTitle?: boolean }) {
  const Icon = pr.merged ? GitMerge : pr.accent === "muted" ? GitPullRequestClosed : GitPullRequest;
  const body = (
    <>
      <Icon aria-hidden className="size-3 shrink-0" />
      {/* The number is code: mono in Classic and Minimal (Modern keeps the
          face it shipped with). */}
      <span className="shrink-0 font-mono tabular-nums">#{pr.number}</span>
      {/* On a phone a row's chip is the number in its state's colour; the
          word comes back from sm up, and always with a title beside it. */}
      <span className={withTitle ? "shrink-0" : "hidden shrink-0 sm:inline modern:inline"}>{pr.label}</span>
      {withTitle && pr.title ? <span className="min-w-0 truncate font-normal">{pr.title}</span> : null}
    </>
  );
  const title = `${pr.repository} #${pr.number}${pr.title ? ` · ${pr.title}` : ""} · ${pr.label}`;
  const tone = TONE_OF_ACCENT[pr.accent];
  return pr.href ? (
    <Link href={pr.href} data-activity-outcome="pr" data-pr-state={pr.label} title={title} onClick={stop} className={chip(tone)}>{body}</Link>
  ) : (
    <span data-activity-outcome="pr" data-pr-state={pr.label} title={title} className={chip(tone)}>{body}</span>
  );
}

/** A task the work touched: green once done. */
export function TaskChip({ task, withTitle = false }: { task: ActivityTask; withTitle?: boolean }) {
  return (
    <Link
      href={entityRoute("task", task.shortId) ?? `/tasks/${task.shortId}`}
      data-activity-outcome="task"
      data-task-done={task.done ? "true" : undefined}
      title={`${task.shortId} · ${task.title}${task.done ? " · done" : ""}`}
      onClick={stop}
      className={chip(task.done ? "green" : "neutral")}
    >
      <CircleCheck aria-hidden className="size-3 shrink-0" />
      <span className="shrink-0 font-mono">{task.shortId}</span>
      {withTitle && task.title ? <span className="min-w-0 truncate font-normal">{task.title}</span> : null}
    </Link>
  );
}

/** A decision: amber while it waits, quiet once answered. */
export function DecisionChip({ decision, sessionId }: { decision: ActivityDecision; sessionId: string }) {
  const href = (decision.shortId && entityRoute("decision", decision.shortId)) || `/conversation/${sessionId}`;
  const Icon = decision.pending ? CircleHelp : CheckCheck;
  return (
    <Link
      href={href}
      data-activity-outcome="decision"
      data-decision-pending={decision.pending ? "true" : undefined}
      title={`${decision.question}${decision.pending ? " · waiting" : " · answered"}`}
      onClick={stop}
      className={chip(decision.pending ? "yellow" : "cyan")}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{decision.pending ? "Decision" : "Answered"}</span>
    </Link>
  );
}

/** A quiet count at the right of a row: a glyph and a number. */
export function QuietCount({ icon: Icon, n, title, kind, className }: { icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>; n: number; title: string; kind: string; className?: string }) {
  return (
    <span data-activity-count={kind} title={title} className={cn("inline-flex items-center gap-1 text-meta tabular-nums text-sol-text-dim", className)}>
      <Icon aria-hidden className="size-3.5" />
      {n}
    </span>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** A row's time: how long ago on today's rows (on the minute clock, so only the
 *  label re-renders), the clock time on an earlier day's. */
export function RowTime({ at, relative }: { at: number; relative: boolean }) {
  return relative ? <RelativeTime at={at} /> : <TimeLabel at={at} text={clock(at)} />;
}

function RelativeTime({ at }: { at: number }) {
  useCoarseNow(60_000);
  return <TimeLabel at={at} text={relTime(at)} />;
}

function TimeLabel({ at, text }: { at: number; text: string }) {
  return (
    // Wide enough for "12:45 PM" in mono (Classic) as well as in Modern's sans.
    <time dateTime={new Date(at).toISOString()} title={formatDateFull(at)} className="w-16 shrink-0 text-right text-meta tabular-nums text-sol-text-dim modern:w-12">
      {text}
    </time>
  );
}
