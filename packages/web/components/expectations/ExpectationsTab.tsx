"use client";
// A project's Expectations tab (the-line-model.md LM5): the project's
// document of how its product should behave, as a page someone with no
// context can read. What an expectation is, in one line; where the document
// stands (lines, areas, version, how often findings broke it lately); the
// proposals waiting; the document by area; its history. A project with none
// yet explains them and offers to start the document, from the team's recent
// context or by hand.
import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Sparkles } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useProjectExpectations, useSyncProjectExpectations, type ProjectExpectationsRow } from "../../hooks/useSyncProjectExpectations";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { shortDay } from "../../lib/line/runReport";
import { ageShort } from "../../lib/lineFlow";
import { cn } from "../../lib/utils";
import { EXPECTATIONS_ABOUT, changePhrase, historyEntries, howApplied, openProposals, usageSummary, type HistoryEntry } from "../../lib/expectations/view";
import { ExpectationsDocument } from "./ExpectationsDocument";
import { draftReading, startExpectationsDraft } from "./draftExpectations";

const btn = "inline-flex h-[28px] items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[12px] transition-colors disabled:opacity-50";

export function ExpectationsTab({ projectId }: { projectId: string }) {
  const { ready } = useSyncProjectExpectations(projectId);
  const row = useProjectExpectations(projectId);
  const title = useInboxStore((s) => (s.projects as Record<string, any>)[projectId]?.title as string | undefined) ?? row?.project.title ?? "this project";
  const [adding, setAdding] = useState(false);
  const empty = !!row && !row.doc && openProposals(row).length === 0;

  return (
    <div className="mx-auto max-w-[72rem] px-4 py-6 sm:px-6 space-y-8" data-expectations-tab={projectId}>
      {!row && !ready ? (
        <p className="text-[12.5px] text-sol-text-dim" data-expectations-loading>Reading the expectations…</p>
      ) : !row ? (
        <p className="text-[12.5px] text-sol-text-dim">These expectations are not readable from this workspace.</p>
      ) : empty ? (
        adding ? (
          <>
            <Header row={row} title={title} onAdd={() => setAdding(true)} />
            <ExpectationsDocument projectId={projectId} adding onAddingChange={setAdding} />
          </>
        ) : (
          <FirstRun projectId={projectId} row={row} title={title} onWrite={() => setAdding(true)} />
        )
      ) : (
        <>
          <Header row={row} title={title} onAdd={() => setAdding(true)} />
          <ExpectationsDocument projectId={projectId} adding={adding} onAddingChange={setAdding} />
          <History row={row} />
        </>
      )}
    </div>
  );
}

/** The draft action: the routine's trigger when installed, else a fresh session; "reading" while a pass is out. */
function useDraft(projectId: string, row: ProjectExpectationsRow | undefined) {
  const now = useCoarseNow(30_000);
  const run = useInboxStore((s) => s.clientState.ui?.expectations_drafts?.[projectId]);
  const reading = draftReading(run, row, now);
  return { reading, session: run?.via === "session" ? run.session_id ?? null : null, start: () => startExpectationsDraft(projectId, row) };
}

function DraftButton({ projectId, row, primary }: { projectId: string; row: ProjectExpectationsRow; primary?: boolean }) {
  const { reading, session, start } = useDraft(projectId, row);
  if (reading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-sol-cyan" data-expectations-drafting>
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sol-cyan" />
        Reading the team's recent context
        {session && <Link href={`/conversation/${session}`} className="text-sol-text-dim underline-offset-2 hover:underline">open the session</Link>}
      </span>
    );
  }
  return (
    <button type="button" onClick={start}
      className={cn(btn, primary ? "border-sol-cyan/50 bg-sol-cyan/10 text-sol-cyan hover:bg-sol-cyan/15" : "border-sol-border/50 text-sol-text-muted hover:bg-sol-bg-alt")}
      title="Reads recent calls, chat, decisions and tasks and proposes changes, each quoting its source. Nothing applies until a person says so."
      data-expectations-draft>
      <Sparkles className="h-3.5 w-3.5" />
      {row.routine ? "Run the daily pass now" : row.doc ? "Propose from recent context" : "Draft from recent context"}
    </button>
  );
}

/** Where the document stands, and the two ways to change it. */
function Header({ row, title, onAdd }: { row: ProjectExpectationsRow; title: string; onAdd: () => void }) {
  const items = row.doc?.items ?? [];
  const active = useMemo(() => items.filter((e) => e.status === "active"), [items]);
  const areas = useMemo(() => new Set(active.map((e) => e.part)).size, [active]);
  const usage = useMemo(() => usageSummary(active, row), [active, row]);
  const open = openProposals(row).length;
  return (
    <header className="space-y-4" data-expectations-header>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-sol-text">How {title} should behave</h2>
          <p className="mt-1 max-w-[46rem] text-[12.5px] leading-relaxed text-sol-text-muted" data-expectations-about>{EXPECTATIONS_ABOUT}</p>
        </div>
        <div className="flex items-center gap-2">
          <DraftButton projectId={row._id} row={row} />
          <button type="button" onClick={onAdd} className={cn(btn, "border-sol-blue/40 text-sol-blue hover:bg-sol-blue/10")} data-expectations-add>
            <Plus className="h-3.5 w-3.5" />Add a line
          </button>
        </div>
      </div>
      {row.doc && (
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-sol-border/30 bg-sol-border/20 sm:grid-cols-4" data-expectations-stats>
          <Stat label="Lines" value={active.length} sub={`in ${areas} ${areas === 1 ? "area" : "areas"}`} />
          <Stat label="Broken in 30 days" value={usage.broken} sub={usage.breaks7 ? `${usage.breaks7} ${usage.breaks7 === 1 ? "break" : "breaks"} this week` : `${usage.breaks30} ${usage.breaks30 === 1 ? "break" : "breaks"} in all`} tone={usage.breaks7 ? "red" : usage.broken ? "orange" : undefined} />
          <Stat label="Never cited" value={usage.quiet} sub="no finding in 30 days" />
          <Stat label="Version" value={row.doc.version} sub={`${shortDay(row.doc.applied_at)}${open ? `, ${open} waiting` : ""}`} tone={open ? "yellow" : undefined} />
        </dl>
      )}
    </header>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: "red" | "orange" | "yellow" }) {
  return (
    <div className="bg-sol-bg px-3 py-2.5" data-expectations-stat={label}>
      <dt className="text-[11px] text-sol-text-dim">{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-2">
        <span className={cn("text-[18px] font-semibold tabular-nums leading-none", tone === "red" ? "text-sol-red" : tone === "orange" ? "text-sol-orange" : tone === "yellow" ? "text-sol-yellow" : "text-sol-text")}>{value}</span>
        <span className="truncate text-[11px] text-sol-text-dim">{sub}</span>
      </dd>
    </div>
  );
}

/** A project with no expectations: what they are, and two ways to start. */
function FirstRun({ projectId, row, title, onWrite }: { projectId: string; row: ProjectExpectationsRow; title: string; onWrite: () => void }) {
  return (
    <div className="mx-auto max-w-[44rem] py-6" data-expectations-first-run>
      <h2 className="text-[17px] font-semibold text-sol-text">Write down how {title} should behave</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-sol-text-muted">
        An expectation is one plain sentence about how the product should behave, quoted from where someone said it: a call, a chat message, a decision, a task.
        Anything that judges behavior grades against these lines and names the one it breaks, so you can see which expectations hold and which keep breaking.
      </p>
      <div className="mt-5 rounded-lg border border-sol-border/30 bg-sol-bg-alt/30 px-3.5 py-3" aria-label="What a line looks like">
        <p className="text-[13px] text-sol-text">A new user sees their first result within a minute of signing up.</p>
        <div className="mt-1 border-l border-sol-border/40 pl-2.5 text-[11.5px] text-sol-text-dim">
          <q className="block italic text-sol-text-muted">if they wait more than a minute for anything, we lost them</q>
          <span>said on a call, with the date and a link to the moment</span>
        </div>
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col items-start rounded-lg border border-sol-cyan/30 p-3.5">
          <div className="text-[12.5px] font-medium text-sol-text">From the team's recent context</div>
          <p className="mt-1 mb-3 flex-1 text-[12px] leading-relaxed text-sol-text-muted">
            A session reads the last two weeks of calls, chat, decisions and tasks about this project and proposes lines, each quoting its source. You review them here; nothing applies until someone says so.
          </p>
          <DraftButton projectId={projectId} row={row} primary />
        </div>
        <div className="flex flex-col items-start rounded-lg border border-sol-border/40 p-3.5">
          <div className="text-[12.5px] font-medium text-sol-text">By hand</div>
          <p className="mt-1 mb-3 flex-1 text-[12px] leading-relaxed text-sol-text-muted">
            Write the first line in your own words, and point at where it was said if you have it. Your words become its first source.
          </p>
          <button type="button" onClick={onWrite} className={cn(btn, "border-sol-blue/40 text-sol-blue hover:bg-sol-blue/10")} data-expectations-write-first>
            <Plus className="h-3.5 w-3.5" />Write the first line
          </button>
        </div>
      </div>
    </div>
  );
}

const HISTORY_SHOWN = 8;

/** Every version, who or what applied it and how, and the proposals closed without one. */
function History({ row }: { row: ProjectExpectationsRow }) {
  const entries = useMemo(() => historyEntries(row.versions ?? [], row.proposals ?? []), [row.versions, row.proposals]);
  const [all, setAll] = useState(false);
  const now = useCoarseNow(60_000);
  if (!entries.length) return null;
  const shown = all ? entries : entries.slice(0, HISTORY_SHOWN);
  return (
    <section data-expectations-history>
      <h3 className="mb-2 border-b border-sol-border/25 pb-1 text-[12.5px] font-semibold text-sol-text">History</h3>
      <ol className="space-y-2.5">
        {shown.map((e) => <HistoryRow key={e.kind === "version" ? `v${e.version}` : e.proposal} e={e} now={now} />)}
      </ol>
      {entries.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="mt-2 text-[11.5px] text-sol-text-dim hover:text-sol-text-muted">{entries.length - shown.length} earlier</button>
      )}
    </section>
  );
}

function HistoryRow({ e, now }: { e: HistoryEntry; now: number }) {
  const when = now - e.at < 86_400_000 ? `${ageShort(now - e.at)} ago` : shortDay(e.at);
  if (e.kind === "closed") {
    return (
      <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 text-[12px] leading-snug" data-expectations-history-entry="closed">
        <span className="tabular-nums text-sol-text-dim">{when}</span>
        <div className="min-w-0 text-sol-text-dim">
          <span>{e.status === "dropped" ? "Dropped" : "Withdrawn"} </span><span className="font-mono text-[10.5px]">{e.proposal}</span>: <span className="text-sol-text-muted">{e.summary}</span>
          {e.reason && <span> ({e.reason})</span>}
        </div>
      </li>
    );
  }
  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 text-[12px] leading-snug" data-expectations-history-entry={`v${e.version}`}>
      <span className="tabular-nums text-sol-text-dim">{when}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold text-sol-text">Version {e.version}</span>
          <span className="text-sol-text-muted">{changePhrase(e)}</span>
          <span className="text-[11px] text-sol-text-dim">{e.active} active</span>
        </div>
        <div className="text-sol-text-muted line-clamp-2">{e.summary}</div>
        <div className="text-[11px] text-sol-text-dim" data-expectations-history-how={e.how}>
          {howApplied(e)}
          {e.proposal && <>, from <span className="font-mono">{e.proposal}</span>{e.proposedBy ? ` proposed by ${e.fromSession ? `${e.proposedBy}'s session` : e.proposedBy}` : ""}</>}
        </div>
      </div>
    </li>
  );
}
