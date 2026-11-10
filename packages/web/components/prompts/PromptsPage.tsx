// /prompts: one day of what each person typed into sessions, a column each,
// oldest prompt at the top. The day lives in the query string (`d=`, the
// viewer's local YYYY-MM-DD), so a link lands on the same day.
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { memo, useMemo, useRef, useState } from "react";
import { addDays } from "@codecast/convex/convex/lib/teamDay";
import { stripPastedContent } from "@codecast/shared/contracts";
import { localDay, parseDay } from "../../lib/changesDay";
import { activeTeamIdOf } from "../../lib/activeTeam";
import { useInboxStore } from "../../store/inboxStore";
import { useTeamRosterIdentity, useViewerIdentity, type RosterIdentity } from "../../hooks/useTeamRoster";
import { usePromptDay, useSyncPromptDay, type PromptRow } from "../../hooks/useSyncPrompts";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOverflows } from "../../hooks/useOverflows";
import { MessageMarkdown } from "../conversation/markdown";
import { Avatar } from "../tasks/TaskCommentStream";
import { PageHeader } from "../ui/page-header";

const PROMPT_MAX_HEIGHT = 220;

type Column = { userId: string; person: RosterIdentity | undefined; rows: PromptRow[]; words: number };

function columnsOf(rows: PromptRow[], roster: RosterIdentity[], viewerId: string | undefined): Column[] {
  const byUser = new Map<string, Column>();
  for (const r of rows) {
    const id = String(r.user_id);
    let col = byUser.get(id);
    if (!col) byUser.set(id, (col = { userId: id, person: roster.find((m) => m._id === id), rows: [], words: 0 }));
    col.rows.push(r);
    col.words += r.words;
  }
  // The viewer first, then whoever typed the most.
  return [...byUser.values()].sort((a, b) => Number(b.userId === viewerId) - Number(a.userId === viewerId) || b.rows.length - a.rows.length);
}

const timeOf = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function PromptsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const now = useCoarseNow(60_000);
  const today = localDay(0, now);
  const asked = params.get("d");
  const date = asked && parseDay(asked) && asked <= today ? asked : today;
  const go = (d: string) => router.replace(d === today ? "/prompts" : `/prompts?d=${d}`);

  const teamId = useInboxStore((s) => activeTeamIdOf(s));
  const feed = useSyncPromptDay(teamId, date);
  const rows = usePromptDay(teamId, date);
  const roster = useTeamRosterIdentity();
  const viewer = useViewerIdentity();
  const columns = useMemo(() => columnsOf(rows, viewer ? [viewer, ...roster] : roster, viewer?._id), [rows, roster, viewer]);

  // The day's controls and tally, drawn by whichever header is up.
  const tally = `${rows.length} ${rows.length === 1 ? "prompt" : "prompts"} · ${columns.length} ${columns.length === 1 ? "person" : "people"}`;
  const dayNav = (
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous day" onClick={() => go(addDays(date, -1))} className="rounded p-1 text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => e.target.value && go(e.target.value)}
            className="rounded border border-sol-border/40 bg-transparent px-2 py-0.5 font-mono text-[12px] text-sol-text"
            aria-label="Day"
          />
          <button type="button" aria-label="Next day" disabled={date >= today} onClick={() => go(addDays(date, 1))} className="rounded p-1 text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text disabled:opacity-30 disabled:hover:bg-transparent">
            <ChevronRight className="h-4 w-4" />
          </button>
          {date !== today && (
            <button type="button" onClick={() => go(today)} className="ml-1 rounded px-2 py-0.5 text-[12px] text-sol-blue hover:bg-sol-blue/10">
              Today
            </button>
          )}
        </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        legacy={
          <header className="flex shrink-0 items-center gap-3 border-b border-sol-border/40 px-5 py-3">
            <h1 className="text-[15px] font-semibold text-sol-text">Prompts</h1>
            {dayNav}
            <span className="ml-auto font-mono text-[12px] tabular-nums text-sol-text-muted">
              {tally}
            </span>
          </header>
        }
        title="Prompts"
        count={tally}
        tabs={dayNav}
      />
      {!teamId ? (
        <Empty>Prompts shows a team's day. Switch to a team to see it.</Empty>
      ) : columns.length === 0 ? (
        <Empty>{feed.ready || feed.refused ? "Nobody typed a prompt this day." : "Loading…"}</Empty>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
          {columns.map((c) => <PersonColumn key={c.userId} column={c} />)}
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 items-center justify-center text-sm text-sol-text-muted">{children}</div>;
}

function PersonColumn({ column }: { column: Column }) {
  const name = column.person?.name || column.person?.github_username || "Someone";
  const image = column.person?.image || column.person?.github_avatar_url;
  return (
    <section className="flex w-[380px] min-w-[300px] shrink-0 flex-col rounded-lg border border-sol-border/40 bg-sol-bg-alt/40">
      <div className="flex shrink-0 items-center gap-2 border-b border-sol-border/30 px-3 py-2">
        <Avatar name={name} image={image} size="md" />
        <span className="truncate text-[13px] font-medium text-sol-text">{name}</span>
        <span className="ml-auto font-mono text-meta tabular-nums text-sol-text-muted">
          {column.rows.length} · {column.words.toLocaleString()}w
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {column.rows.map((r) => <PromptCard key={r._id} row={r} />)}
      </div>
    </section>
  );
}

const PromptCard = memo(function PromptCard({ row }: { row: PromptRow }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const text = useMemo(() => stripPastedContent(row.text).trim(), [row.text]);
  const overflows = useOverflows(ref, PROMPT_MAX_HEIGHT, [text]);
  const href = `/conversation/${row.conversation_id}#msg-${row.message_id}`;
  const header = (
    <Link href={href} className="group flex items-baseline gap-2 text-meta">
      <span className="shrink-0 font-mono tabular-nums text-sol-text-dim">{timeOf(row.timestamp)}</span>
      <span className="truncate text-sol-text-muted group-hover:text-sol-blue">{row.session_title}</span>
    </Link>
  );
  if (row.decision) return <DecisionCard row={row} decision={row.decision} header={header} text={text} />;
  return (
    <article className="rounded-md border border-sol-border/30 bg-sol-card px-3 py-2">
      {header}
      <div
        ref={ref}
        className="prose prose-invert prose-sm mt-1 max-w-none break-words text-sm text-sol-text"
        style={!open && overflows ? { maxHeight: PROMPT_MAX_HEIGHT, overflow: "hidden" } : undefined}
      >
        <MessageMarkdown content={text} userText />
      </div>
      {(overflows || row.clipped) && (
        <div className="mt-1 flex gap-3 text-meta">
          {overflows && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="text-sol-text-dim hover:text-sol-blue">
              {open ? "Show less" : "Show all"}
            </button>
          )}
          {row.clipped && open && (
            <Link href={href} className="text-sol-text-dim hover:text-sol-blue">Rest in the session</Link>
          )}
        </div>
      )}
    </article>
  );
});

// A decision answer: the question it answered, then the answer. A picked
// option reads as a choice (a check and its label); a written answer reads
// like any prompt.
function DecisionCard({ row, decision, header, text }: { row: PromptRow; decision: NonNullable<PromptRow["decision"]>; header: React.ReactNode; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="rounded-md border border-sol-border/30 border-l-2 border-l-sol-violet/60 bg-sol-card px-3 py-2">
      {header}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mt-1 flex w-full items-start gap-1.5 text-left text-[12px] text-sol-text-muted hover:text-sol-text"
      >
        <span className="shrink-0 text-mark uppercase leading-[18px] tracking-wide text-sol-violet">decision</span>
        <span className={`leading-[18px] ${open ? "" : "line-clamp-2"}`}>{decision.question || "the agent's question"}</span>
      </button>
      {decision.picked ? (
        <div className="mt-1 flex items-start gap-1.5 text-sm font-medium text-sol-text">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sol-green" />
          <span className="min-w-0 break-words">{text}</span>
        </div>
      ) : (
        <div className="prose prose-invert prose-sm mt-1 max-w-none break-words text-sm text-sol-text">
          <MessageMarkdown content={text} userText />
        </div>
      )}
      {row.clipped && <Link href={`/conversation/${row.conversation_id}#msg-${row.message_id}`} className="mt-1 block text-meta text-sol-text-dim hover:text-sol-blue">Rest in the session</Link>}
    </article>
  );
}
