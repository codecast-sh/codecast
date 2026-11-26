// Priorities lab (throwaway prototype): the small pieces every row draws: the
// thin day bars, the chips (one shape and icon per object type, so they read
// in grayscale), the other-sessions count, and the live session states read
// off the store.
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "../../ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "../../ui/popover";
import { GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, MessageSquare, Rocket, Square, SquareCheck, Target, Workflow } from "lucide-react";
import { entityRoute } from "@codecast/shared/entities";
import { HEAT_COLORS, heatColor } from "../../ActivityHeatmap";
import { HoverCard } from "../../ui/HoverCard";
import { SessionStatusMark } from "../../inbox/SessionStatusMark";
import { SESSION_STATUS, sessionStatusOf, type SessionStatus } from "../../../lib/sessionStatus";
import { railRowPlacement, useInboxStore } from "../../../store/inboxStore";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { cn } from "../../../lib/utils";
import { useEntityResolution } from "../../../lib/entityDisplay";
import { findEntityInStore } from "../../../lib/liveEntities";
import { ago, isAutomated, STEP_TITLE, stepTitle, type ConnectedRaw, type DeployInfo, type PlanInfo, type PrInfo, type SessionView, type TaskInfo } from "./labModel";

// One fixed grid for every row on the page, so each column sits at the same x down the list:
//   rank | title | progress | today | 10 days | menu      (wide)
//   rank | title | progress | today | menu                (narrow: no strip)
// A milestone line spans title+progress with its own split at a fixed fraction, so its chips start at
// one x on every line. (Every class spelled out whole: Tailwind only generates what it reads literally.)
export const GRID = "grid grid-cols-[20px_minmax(0,1fr)_auto_30px_24px] items-center gap-x-2.5 [@container(min-width:44rem)]:grid-cols-[20px_minmax(0,1fr)_112px_34px_52px_24px] [@container(min-width:44rem)]:gap-x-3";
export const C_RANK = "col-start-1 row-start-1";
export const C_TITLE = "col-start-2 row-start-1 min-w-0";
export const C_PROGRESS = "col-start-3 row-start-1 justify-self-end";
export const C_TODAY = "col-start-4 row-start-1 justify-self-center";
export const C_STRIP = "hidden col-start-5 row-start-1 justify-self-end [@container(min-width:44rem)]:block";
export const C_MENU = "col-start-5 row-start-1 justify-self-end [@container(min-width:44rem)]:col-start-6";
/** Under the title: from the title column to the strip. */
export const C_META = "col-start-2 col-end-[-2] row-start-2 min-w-0";
/** A milestone line's text and chips: title and progress columns. */
export const C_LINE = "col-start-2 col-end-4 row-start-1 min-w-0";
export const LINE_SPLIT = "grid grid-cols-1 items-center gap-x-3 gap-y-1 [@container(min-width:44rem)]:grid-cols-[minmax(0,11fr)_minmax(0,9fr)]";
export const MENU_VISIBLE_NARROW = "[@container(max-width:44rem)]:opacity-100";

const levelOf = (n: number, cuts: number[]) => (n <= 0 ? 0 : 1 + cuts.filter((c) => n > c).length);

/** Ten days as thin bars, height by typing, a stub for none; today wider and outlined; a dot over a day a milestone landed. */
export function LabStrip({ counts, todayIndex, levels, landed, size }: {
  counts: number[];
  todayIndex: number;
  levels: number[];
  landed?: boolean[];
  size: "head" | "line" | "page";
}) {
  const max = size === "page" ? 30 : size === "head" ? 14 : 10;
  const bar = size === "page" ? (today: boolean) => (today ? "w-[11px]" : "w-[10px]") : (today: boolean) => (today ? "w-[4px]" : "w-[3px]");
  return (
    <span className={cn("flex items-end", size === "page" ? "gap-[4px]" : "gap-px")} style={{ height: max + (landed ? 6 : 0) }}>
      {counts.map((c, i) => {
        const lv = Math.min(4, levelOf(c, levels));
        const h = c <= 0 ? 2 : Math.max(3, Math.round((lv / 4) * max));
        const today = i === todayIndex;
        return (
          <span key={i} className="flex flex-col items-center justify-end gap-[2px]" title={`${c} typed${landed?.[i] ? " · milestone landed" : ""}`}>
            {landed && <i className={cn("block rounded-full", size === "page" ? "size-[5px]" : "size-[3px]", landed[i] ? "bg-sol-green" : "bg-transparent")} />}
            <i
              className={cn("block rounded-[1px]", bar(today))}
              style={{ height: h, background: c > 0 ? heatColor(c, levels, HEAT_COLORS) : "color-mix(in srgb, var(--sol-text) 14%, transparent)" }}
            />
          </span>
        );
      })}
    </span>
  );
}

type LiveSession = { status: SessionStatus; title: string; updated_at: number; convId: string; auto: boolean };

/** Live state for each session short id (a 7-character prefix of the conversation id), from the inbox's own rows. */
export function useSessionStates(ids: string[]): Map<string, LiveSession> {
  const now = useCoarseNow(30_000);
  const key = ids.join(",");
  const sig = useInboxStore((s) => {
    const index = prefixIndex(s.sessions as Record<string, any>);
    return key.split(",").filter(Boolean).map((id) => {
      const row = index.get(id.slice(0, 7).toLowerCase());
      if (!row) return "";
      const status = sessionStatusOf({ row, placement: railRowPlacement(row, now), now });
      const title = (row.title ?? "").replace(/[\u0001\u0002]/g, "");
      return [id, status, row.updated_at ?? 0, row._id, isAutomated(row, title) ? 1 : 0, title].join("\u0001");
    }).filter(Boolean).join("\u0002");
  });
  return useMemo(() => {
    const out = new Map<string, LiveSession>();
    for (const part of sig.split("\u0002").filter(Boolean)) {
      const [id, status, upd, convId, auto, title] = part.split("\u0001");
      out.set(id, { status: status as SessionStatus, updated_at: Number(upd), convId, auto: auto === "1", title });
    }
    return out;
  }, [sig]);
}

const prefixIndexes = new WeakMap<object, Map<string, any>>();
export function prefixIndex(coll: Record<string, any> | undefined): Map<string, any> {
  if (!coll) return new Map();
  let idx = prefixIndexes.get(coll);
  if (!idx) {
    idx = new Map();
    for (const id in coll) idx.set(id.slice(0, 7).toLowerCase(), coll[id]);
    prefixIndexes.set(coll, idx);
  }
  return idx;
}

export function sessionView(raw: ConnectedRaw, live: ReturnType<typeof useSessionStates>): SessionView {
  const l = live.get(raw.short_id);
  return {
    short_id: raw.short_id,
    why: raw.why,
    title: raw.title || l?.title || "",
    status: l?.status ?? null,
    auto: l?.auto ?? STEP_TITLE.test(raw.title),
    updated_at: Math.max(raw.updated_at, l?.updated_at ?? 0),
    href: l ? `/conversation/${l.convId}` : entityRoute("session", raw.short_id) ?? "#",
  };
}

const stop = (e: React.MouseEvent) => e.stopPropagation();

export function StateMark({ status, size = 12 }: { status: SessionStatus | null; size?: number }) {
  return status
    ? <SessionStatusMark status={status} size={size} />
    : <span className="shrink-0 rounded-full border border-dashed border-sol-text-dim/70" style={{ width: size, height: size }} />;
}

// ── Chips: one shape and one icon per type ──

/** A session: a round pill, its state (spelled out when it needs you), a chat or workflow glyph, its title. The id is in the tooltip. */
export function SessionChip({ s, className, hideState }: { s: SessionView; className?: string; hideState?: boolean }) {
  const asks = s.status === "needs_you" || s.status === "error";
  return (
    <Link
      href={s.href}
      onClick={stop}
      title={`${s.short_id} · ${s.title || "Session"} · ${s.status ? SESSION_STATUS[s.status].word : "State not on this device"}`}
      className={cn(
        "inline-flex h-6 min-w-0 max-w-[17rem] shrink items-center gap-1.5 rounded-full border border-sol-border/80 bg-sol-bg-alt px-2 text-meta text-sol-text hover:border-sol-text-dim/60",
        className,
      )}
    >
      {!hideState && <StateMark status={s.status} size={12} />}
      {!hideState && asks && <span className="shrink-0 font-semibold text-sol-yellow">{SESSION_STATUS[s.status!].word}</span>}
      {s.auto ? <Workflow className="size-3 shrink-0 text-sol-text-dim" aria-hidden /> : <MessageSquare className="size-3 shrink-0 text-sol-text-dim" aria-hidden />}
      <span className="min-w-0 truncate"><SessionTitle s={s} /></span>
    </Link>
  );
}

/** Today: filled when anything was typed into it today, hollow when not; a priority row adds the count. */
export function TodayDot({ count, showCount }: { count: number; showCount?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-meta tabular-nums text-sol-text-muted" title={count ? `${count} typed today` : "Nothing typed today"}>
      <i className={cn("block size-[9px] rounded-full", count > 0 ? "bg-sol-green" : "border-[1.5px] border-sol-text-dim/60")} />
      {showCount && count > 0 && <span>{count}</span>}
    </span>
  );
}

/** A plan: square corners and a hairline border, a target glyph, its title, a tiny progress bar and the count. */
export function PlanChip({ plan, prefix, className }: { plan: PlanInfo; prefix?: string; className?: string }) {
  const pct = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;
  return (
    <Link
      href={`/plans/${plan.short_id}`}
      onClick={stop}
      title={`${plan.short_id} · ${plan.title} · ${plan.done}/${plan.total} done${plan.size > plan.total ? ` · ${plan.size} tasks` : ""}`}
      className={cn("inline-flex h-6 min-w-[6rem] max-w-[15rem] shrink items-center gap-1.5 rounded-[3px] border border-sol-border px-1.5 text-meta text-sol-text hover:border-sol-text-dim/60", className)}
    >
      <Target className="size-3 shrink-0 text-sol-text-dim" aria-hidden />
      {prefix && <span className="shrink-0 text-sol-text-dim">{prefix}</span>}
      <span className="min-w-0 truncate">{plan.title || plan.short_id}</span>
      <span aria-hidden className="relative block h-[3px] w-6 shrink-0 overflow-hidden rounded-full bg-sol-text/15">
        <span className="absolute inset-y-0 left-0 bg-sol-text-muted" style={{ width: `${pct}%` }} />
      </span>
      <span className="shrink-0 tabular-nums text-sol-text-dim">{plan.done}/{plan.total}</span>
    </Link>
  );
}

/** A task: no frame, a checkbox and its title. */
export function TaskChip({ task, className }: { task: TaskInfo; className?: string }) {
  const Box = task.done ? SquareCheck : Square;
  return (
    <Link href={entityRoute("task", task.short_id) ?? "#"} onClick={stop} title={`${task.short_id} · ${task.title}`} className={cn("inline-flex h-6 min-w-[5rem] max-w-[14rem] shrink items-center gap-1 px-0.5 text-meta text-sol-text hover:underline decoration-sol-text-dim/50", task.done && "text-sol-text-muted", className)}>
      <Box className="size-3.5 shrink-0 text-sol-text-dim" aria-hidden />
      <span className="min-w-0 truncate">{task.title || task.short_id}</span>
    </Link>
  );
}

const PR_LOOK = {
  open: { Icon: GitPullRequest, cls: "border-sol-green/45 text-sol-green" },
  merged: { Icon: GitMerge, cls: "border-sol-violet/45 text-sol-violet" },
  closed: { Icon: GitPullRequestClosed, cls: "border-sol-red/45 text-sol-red" },
} as const;

/** A pull request: a solid-edged tag, the PR glyph for its state (open, merged, closed) and its number. */
export function PrChip({ pr }: { pr: PrInfo }) {
  const look = PR_LOOK[pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : "open"];
  return (
    <a href={`https://github.com/${pr.repository}/pull/${pr.number}`} target="_blank" rel="noreferrer" onClick={stop} title={`${pr.repository}#${pr.number} · ${pr.title} · ${pr.state}`}
      className={cn("inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[5px] border-[1.5px] bg-sol-bg px-1.5 font-mono text-meta tabular-nums", look.cls)}>
      <look.Icon className="size-3" aria-hidden />#{pr.number}
    </a>
  );
}

/** A branch: a dashed frame, the branch glyph and its name in mono. */
export function BranchChip({ name }: { name: string }) {
  return (
    <span title={name} className="inline-flex h-[22px] min-w-[5rem] max-w-[13rem] shrink items-center gap-1 rounded-[3px] border border-dashed border-sol-text-dim/60 px-1.5 font-mono text-[11px] text-sol-text-muted">
      <GitBranch className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

/** A deploy: a rocket, where it went and how long ago, in its status colour. */
export function DeployChip({ d, now }: { d: DeployInfo; now: number }) {
  const tone = d.status === "live" ? "text-sol-green" : d.status === "failed" ? "text-sol-red" : "text-sol-text-muted";
  return (
    <Link href={`/deploys?deploy=${d.short_id}`} onClick={stop} title={`${d.short_id} · ${d.target} · ${d.status}`}
      className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-sol-text/[0.07] px-2 text-meta text-sol-text hover:bg-sol-text/[0.12]">
      <Rocket className={cn("size-3", tone)} aria-hidden />
      <span>{d.target}</span>
      <span className="tabular-nums text-sol-text-dim">{ago(d.at, now).replace(" ago", "")}</span>
    </Link>
  );
}

/** Why each session is connected: mapped by the pass, linked by a ref, bound to a task. */
export function WhyTags({ why, className }: { why: string[]; className?: string }) {
  const viaTasks = why.filter((w) => w.startsWith("via ct-"));
  const shown = viaTasks.length > 2 ? [...why.filter((w) => !w.startsWith("via ct-")), `via ${viaTasks.length} tasks`] : why;
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {shown.map((w) => (
        <span key={w} title={w.endsWith(" tasks") ? viaTasks.join(", ") : undefined} className="rounded-[4px] bg-sol-text/[0.06] px-1 text-[10px] leading-4 text-sol-text-muted">{w}</span>
      ))}
    </span>
  );
}

/** A session's title: the one the pass or the inbox gave, else read from the server by its short id. */
export function SessionTitle({ s }: { s: SessionView }) {
  return s.title ? <>{s.title}</> : <ResolvedSessionTitle id={s.short_id} />;
}
function ResolvedSessionTitle({ id }: { id: string }) {
  const r = useEntityResolution(id, "session");
  const raw = (r.entity as { title?: string } | null)?.title;
  // A workflow step reads as what it works on ("Review: <task title>") here too.
  const title = raw ? stepTitle(raw, (tid) => findEntityInStore(useInboxStore.getState(), "task", tid) as { title?: string } | undefined) ?? raw : raw;
  return title ? <>{title}</> : <span className="text-sol-text-dim">Untitled session</span>;
}

const URGENCY: Array<[SessionStatus[], string]> = [
  [["needs_you", "error"], "text-sol-yellow"],
  [["working", "starting"], "text-sol-blue"],
];

/** The milestone's other sessions: "+N" in the most urgent state's colour among them, the list on hover. */
export function OtherSessions({ others, now }: { others: SessionView[]; now: number }) {
  if (others.length === 0) return null;
  const tone = URGENCY.find(([states]) => others.some((s) => s.status && states.includes(s.status)))?.[1] ?? "text-sol-text-dim";
  const card = (
    <div className="max-h-80 overflow-y-auto py-1">
      <div className="px-3 pb-1 pt-1.5 text-mark font-semibold uppercase tracking-wide text-sol-text-dim">{others.length} more {others.length === 1 ? "session" : "sessions"}</div>
      <ul>
        {others.map((s) => (
          <li key={s.short_id}>
            <Link href={s.href} className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-2 px-3 py-1 text-ui hover:bg-sol-bg-alt">
              <span className="pt-[5px]"><StateMark status={s.status} /></span>
              <span className="min-w-0">
                <span className="block truncate text-sol-text"><SessionTitle s={s} /></span>
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-sol-text-dim">
                  <span>
                    <span className={s.status ? SESSION_STATUS[s.status].text : undefined}>{s.status ? SESSION_STATUS[s.status].word : "State unknown"}</span>
                    {s.updated_at ? ` · ${ago(s.updated_at, now)}` : ""}
                  </span>
                  <WhyTags why={s.why} />
                </span>
              </span>
              <span className="pt-px font-mono text-meta text-sol-text-dim">{s.short_id}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <HoverCard card={card} side="bottom" className="w-[22rem]" triggerClassName="inline-flex shrink-0 items-center" focusable>
      <span data-lab-others role="button" tabIndex={0} aria-label={`${others.length} more sessions`} onClick={stop}
        className={cn("inline-flex h-6 cursor-default items-center rounded-full px-1.5 text-meta font-semibold tabular-nums hover:bg-sol-bg-alt", tone)}>
        +{others.length}
      </span>
    </HoverCard>
  );
}

/** A collapsible line in an open milestone: its label, then its chips wrapping on the line. */
export function TypeRow({ label, count, open, onToggle, children }: { label: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2 py-0.5">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex h-6 w-24 shrink-0 items-center gap-1 text-left text-mark font-semibold uppercase tracking-wide text-sol-text-dim hover:text-sol-text-muted">
        {label}{!open && <span className="font-normal normal-case tabular-nums tracking-normal"> · {count} ›</span>}
      </button>
      {open && <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>}
    </div>
  );
}

/** The rail's colour: the driving session's state (needs you, working), grey otherwise. */
export function stateTone(status: SessionStatus | null): string {
  if (status === "needs_you" || status === "error") return "var(--sol-yellow)";
  if (status === "working" || status === "starting") return "var(--sol-blue)";
  return "color-mix(in srgb, var(--sol-text-dim) 75%, transparent)";
}

/** "Correct…": what the pass should know about this priority or milestone. Saving is the prototype's toast. */
export function CorrectPopover({ open, onOpenChange, subject, children }: { open: boolean; onOpenChange: (open: boolean) => void; subject: string; children: ReactNode }) {
  const [text, setText] = useState("");
  const close = () => { onOpenChange(false); setText(""); };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent align="end" sideOffset={6} className="w-80 p-3" onClick={(e) => e.stopPropagation()}>
        <div className="truncate text-meta text-sol-text-dim">Correct <span className="font-medium text-sol-text">{subject}</span></div>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What should the pass know?"
          className="mt-2 h-24 w-full resize-none rounded-control border border-sol-border bg-sol-bg px-2.5 py-2 text-ui text-sol-text placeholder:text-sol-text-dim focus:border-sol-blue/60 focus:outline-none"
        />
        <div className="mt-2 flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={() => { close(); toast("Correction saved: prototype only"); }}>Save</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
