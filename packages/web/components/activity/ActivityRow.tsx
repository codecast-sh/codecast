import { memo, useMemo, useState } from "react";
import type React from "react";
import Link from "next/link";
import { ChevronRight, GitCommit, ListChecks, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { entityRoute } from "@codecast/shared/entities";
import { useInboxStore } from "../../store/inboxStore";
import { SESSION_STATUS } from "../../lib/sessionStatus";
import { requestSessionRestart } from "../../lib/sessionCommands";
import { getLabelColor } from "../../lib/labelColors";
import { formatModel } from "../../lib/conversationProcessor";
import { ghostRestartContextFor } from "../../hooks/useSessionRestart";
import { cleanUserMessage } from "../sessionMessage";
import { AgentTypeIcon, formatAgentType } from "../AgentTypeIcon";
import { TeamShareChip } from "../feed/TeamShareChip";
import { shortDuration } from "../feed/activityFeedFormat";
import { SessionStatusMark, SessionStatusWord } from "../inbox/SessionStatusMark";
import { Button } from "../ui/button";
import { DecisionChip, Face, PrChip, QuietCount, RowTime, TaskChip } from "./ActivityParts";
import { branchOf, type ActivityItem } from "./activityModel";

// One session on the Modern Activity page: ONE line, 36px, the shared status
// mark and word (lib/sessionStatus, the rail's vocabulary), the title (a link
// to the session), the one line about the work, and at the right what it
// produced and when. Everything else is behind the chevron: the summary in
// full, what was asked, the facts, every outcome as a link, and the actions.

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** The press a session that waits on someone offers on the spot. */
function primaryAction(item: ActivityItem): { kind: "answer" | "restart"; href?: string; label: string } | null {
  const ask = item.outcomes.decisions.find((d) => d.pending && d.askedOfViewer);
  if (ask) return { kind: "answer", label: "Answer", href: (ask.shortId && entityRoute("decision", ask.shortId)) || `/conversation/${item.id}` };
  if (item.isOwn && item.status === "error") return { kind: "restart", label: "Restart" };
  if (item.isOwn && item.status === "needs_you") return { kind: "answer", label: "Answer", href: `/conversation/${item.id}` };
  return null;
}

function restart(id: string) {
  requestSessionRestart(id, ghostRestartContextFor(id)).catch(() => toast.error("Could not restart the session"));
}

/** Answer, Restart or Open: what the person can do about a session right here. */
export function ActivityActions({ item, size = "sm" }: { item: ActivityItem; size?: "sm" | "xs" }) {
  const primary = primaryAction(item);
  const open = `/conversation/${item.id}`;
  return (
    <span data-activity-actions className="flex shrink-0 items-center gap-1.5" onClick={stop}>
      {primary?.kind === "restart" ? (
        <Button type="button" variant="outline" size={size} data-activity-action="restart" onClick={() => restart(item.id)}>
          <RotateCw aria-hidden />
          Restart
        </Button>
      ) : primary ? (
        <Button asChild variant="primary" size={size} data-activity-action="answer">
          <Link href={primary.href!}>{primary.label}</Link>
        </Button>
      ) : null}
      <Button asChild variant={primary ? "ghost" : "outline"} size={size} data-activity-action="open" className={primary ? "hidden sm:inline-flex" : undefined}>
        <Link href={open}>Open</Link>
      </Button>
    </span>
  );
}

export const ActivityRow = memo(function ActivityRow({ item, relative, showActor = false, needsRow = false, teamId }: {
  item: ActivityItem;
  /** Today's rows say how long ago; earlier days say the clock time. */
  relative: boolean;
  /** Grouped by project, each row names whose it is. */
  showActor?: boolean;
  /** In the Needs someone group: the actions take the counts' place. */
  needsRow?: boolean;
  /** The team feed: the viewer's own rows offer the share picker. */
  teamId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const meta = SESSION_STATUS[item.status];
  const { prs, commits, tasks, decisions } = item.outcomes;
  const pending = decisions.find((d) => d.pending);
  const toggle = () => setOpen((v) => !v);
  return (
    <li data-activity-row={item.id} data-status={item.status} data-expanded={open ? "true" : undefined} className="list-none">
      <div
        onClick={toggle}
        className={`flex h-9 cursor-pointer items-center gap-2 rounded-control pl-0.5 pr-1.5 transition-colors duration-press hover:bg-sol-text/[0.04] ${open ? "bg-sol-text/[0.03]" : ""} ${item.hiddenFromTeam ? "opacity-60 hover:opacity-100" : ""}`}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
          onClick={(e) => { stop(e); toggle(); }}
          className="flex size-6 shrink-0 items-center justify-center rounded-[4px] text-sol-text-dim outline-none hover:text-sol-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--focus-ring)]"
        >
          <ChevronRight aria-hidden className={`size-3.5 transition-transform duration-press ${open ? "rotate-90" : ""}`} />
        </button>
        {showActor && <span title={item.actor.name}><Face actor={item.actor} size={18} /></span>}
        <span className="flex shrink-0 items-center gap-1.5 sm:w-[5.5rem]" title={meta.meaning}>
          <SessionStatusMark status={item.status} />
          <SessionStatusWord status={item.status} title={item.reason ?? meta.meaning} className="hidden truncate text-ui font-medium sm:block" />
        </span>
        <Link
          href={`/conversation/${item.id}`}
          onClick={stop}
          data-activity-title
          title={item.title}
          className="min-w-0 flex-1 truncate text-ui font-medium text-sol-text hover:underline sm:max-w-[40%] sm:flex-none sm:shrink-0"
        >
          {item.title}
        </Link>
        <span data-activity-line title={[item.reason, item.line].filter(Boolean).join(" · ") || undefined} className="hidden min-w-0 flex-1 truncate text-ui text-sol-text-muted sm:block">
          {item.reason ? <span className={meta.text}>{item.reason}</span> : null}
          {item.reason && item.line ? <span aria-hidden className="text-sol-text-dim"> · </span> : null}
          {item.line}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {needsRow ? (
            <ActivityActions item={item} size="xs" />
          ) : (
            <>
              {pending && <DecisionChip decision={pending} sessionId={item.id} />}
              {prs[0] && <PrChip pr={prs[0]} />}
              {prs.length > 1 && <span className="text-meta tabular-nums text-sol-text-dim" title={prs.slice(1).map((p) => `#${p.number} ${p.label}`).join(", ")}>+{prs.length - 1}</span>}
              {commits > 0 && <QuietCount icon={GitCommit} n={commits} kind="commits" title={`${commits} commit${commits === 1 ? "" : "s"}`} />}
              {tasks.length > 0 && <QuietCount icon={ListChecks} n={tasks.length} kind="tasks" title={`${tasks.length} task${tasks.length === 1 ? "" : "s"} (${tasks.filter((t) => t.done).length} done)`} />}
            </>
          )}
          <RowTime at={item.at} relative={relative} />
        </span>
      </div>
      {open && <ActivityRowDetail item={item} teamId={teamId} />}
    </li>
  );
});

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-1 text-mark font-medium uppercase tracking-wide text-sol-text-dim">{children}</div>
);

/** What a row opens into: the summary whole, what was asked, the facts, every
 *  outcome as a link, and the actions. */
function ActivityRowDetail({ item, teamId }: { item: ActivityItem; teamId?: string | null }) {
  const conv = item.conv;
  // The viewer's own row knows what they last sent; read once per change of
  // the item, never subscribed.
  const lastPrompt = useMemo(() => cleanUserMessage(useInboxStore.getState().sessions[item.id]?.last_user_message), [item]);
  const firstPrompt = useMemo(() => cleanUserMessage(conv.first_user_message), [conv.first_user_message]);
  const summary = (conv.visibility_mode === "minimal" ? null : conv.subtitle?.trim()) || conv.activity_summary?.trim() || item.line;
  const exchange = (conv.message_alternates ?? []).slice(-4);
  const { prs, commits, tasks, decisions } = item.outcomes;
  const facts: Array<[string, React.ReactNode]> = [];
  if (item.project) facts.push(["Project", <span key="p" className="inline-flex items-center gap-1.5"><span aria-hidden className={`size-1.5 rounded-full ${getLabelColor(item.project).dot}`} />{item.project}</span>]);
  const branch = branchOf(conv);
  if (branch) facts.push(["Branch", <span key="b" className="font-mono">{branch}</span>]);
  facts.push(["Agent", <span key="a" className="inline-flex items-center gap-1.5"><AgentTypeIcon agentType={conv.agent_type || "claude_code"} className="size-3.5" />{formatAgentType(conv.agent_type || "claude_code")}{conv.model ? ` · ${formatModel(conv.model)}` : ""}</span>]);
  if ((conv.message_count ?? 0) > 0) facts.push(["Messages", <span key="m" className="tabular-nums">{conv.message_count}</span>]);
  if (conv.duration_ms > 60_000) facts.push(["Ran", <span key="d" className="tabular-nums">{shortDuration(conv.duration_ms)}</span>]);
  if (conv.started_at) facts.push(["Started", <span key="s" className="tabular-nums">{new Date(conv.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>]);
  const hasOutcomes = prs.length > 0 || tasks.length > 0 || decisions.length > 0 || commits > 0;

  return (
    <div data-activity-detail className="mb-2 ml-8 mt-0.5 space-y-3 rounded-card border border-sol-border bg-sol-card px-3.5 py-3 text-ui text-sol-text">
      <div className="flex items-start gap-2">
        <Face actor={item.actor} size={20} className="mt-px" />
        <div className="min-w-0 flex-1">
          <div className="text-ui text-sol-text-muted">{item.actor.name}</div>
          {summary ? <p className="mt-1 whitespace-pre-line break-words text-body leading-relaxed text-sol-text">{summary}</p> : null}
        </div>
      </div>
      {(firstPrompt || lastPrompt || exchange.length > 0) && (
        <div>
          <Label>Asked</Label>
          <div className="space-y-1.5">
            {firstPrompt && <p className="line-clamp-4 whitespace-pre-line break-words text-sol-text-muted">{firstPrompt}</p>}
            {exchange.map((m, i) => (
              <p key={i} className="line-clamp-3 whitespace-pre-line break-words text-sol-text-muted">
                <span className="mr-1.5 font-medium text-sol-text">{m.role === "user" ? "You" : "Agent"}</span>
                {m.content}
              </p>
            ))}
            {lastPrompt && lastPrompt !== firstPrompt && (
              <p className="line-clamp-4 whitespace-pre-line break-words text-sol-text-muted"><span className="mr-1.5 font-medium text-sol-text">Last</span>{lastPrompt}</p>
            )}
          </div>
        </div>
      )}
      {hasOutcomes && (
        <div>
          <Label>Produced</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {prs.map((p) => <PrChip key={p.key} pr={p} withTitle />)}
            {tasks.map((t) => <TaskChip key={t.id} task={t} withTitle />)}
            {decisions.map((d) => <DecisionChip key={d.id} decision={d} sessionId={item.id} />)}
            {commits > 0 && <QuietCount icon={GitCommit} n={commits} kind="commits" title={`${commits} commit${commits === 1 ? "" : "s"}`} />}
          </div>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui sm:grid-cols-[auto_1fr_auto_1fr]">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-sol-text-dim">{k}</dt>
            <dd className="min-w-0 truncate text-sol-text">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <ActivityActions item={item} />
        {item.isOwn && teamId ? <TeamShareChip conv={conv} teamId={teamId} /> : null}
      </div>
    </div>
  );
}
