"use client";
// A finder's page (line-journeys.md LJ8.6): Line › Codecast comms judge. Its job is to
// tell whether this finder can be trusted and to correct it. The head says
// what it looks for, its findings this week and how often people marked it
// wrong. Below, this week's findings in three groups (filed to a problem,
// counted as the Find table counts it; marked wrong; not filed), then older,
// each opened in place as the real thing (FindingReader: the conversation a
// judge read with the judged words marked, else the finding's own words and
// its link). "Judge is wrong" sits on an open judge finding; nothing else is
// drawn as an act until its backend exists (LJ9 item 9). A finder whose
// findings ask the team to act by a date (Union's escalations) lists those
// first as Team asks, soonest due first, each opening its task in the product.
import { Fragment, useMemo, useRef, useState } from "react";
import { useMountEffect } from "../../../../../hooks/useMountEffect";
import { finderGroups, findingAt, findingsOf, finderNamed, flatSources, markable, wrongRateWords, type FinderGroup } from "../../../../../lib/line/sourcesView";
import { watchesFor } from "../../../../../lib/line/lineSources";
import { moreWords } from "../../../../../lib/line/listWords";
import { problemListName } from "../../../../../lib/line/problemTable";
import { FindingReader, useFinderName } from "../../../widgets/FindingReader";
import { askCauses, dueWords, teamAsks, type AskCause, type AskSignal, type TeamAsk } from "../../../../../lib/line/teamAsks";
import { escalationFinding, evidenceLinkWords } from "../../../../../lib/line/problemPage";
import { askCauseLedger } from "../../../../../lib/line/findingLedger";
import { SwitchReview } from "../../../../consequential/ConsequentialSwitch";
import { useInboxStore } from "../../../../../store/inboxStore";
import type { LineViewProps } from "../types";
import { useFinders, type FinderSignal } from "./FindTable";
import "./finder.css";

/** How many findings a group shows before "Show more". */
const PAGE = 30;

export function FinderPage({ workspace, selection, select, href }: LineViewProps) {
  // A finder's figures are its whole, whichever process's table it was opened from (useFinders), so one finder opened
  // from any process, a link or a finding's source reads the numbers its table rows read.
  const { sources, signals, marks, rows, window, windowWords, elsewhere } = useFinders(workspace, { everyProcess: true });
  const flat = useMemo(() => flatSources(sources), [sources]);
  const row = finderNamed(flat, selection.source, (r) => findingsOf(signals, r).length > 0) ?? finderNamed(flat, selection.source);
  const parent = row?.judge != null ? sources.find((s) => s.source === row.source && s.judge == null) ?? null : null;
  const findings = useMemo(() => (row ? findingsOf(signals, row) : []), [signals, row]);
  const groups = useMemo(() => finderGroups(findings, marks, window), [findings, marks, window]);
  const asks = useMemo(() => teamAsks(findings as unknown as Array<FinderSignal & AskSignal>), [findings]);
  const stat = rows.find((r) => r.row.key === row?.key) ?? null;
  const who = useFinderName();
  // A problem named the way the Problems list names it (its short name, else its title without the stored cut).
  const tasks = useMemo(() => {
    const named = new Map(workspace.problems.map((i) => [i.id, i.name ?? null]));
    return new Map((workspace.rows.tasks as unknown as Array<{ _id: string; short_id?: string; title: string; status?: string; assignee?: string | null }>).map((t) => [t._id, { ...t, title: problemListName({ title: t.title, name: named.get(t._id) }) }]));
  }, [workspace.rows.tasks, workspace.problems]);
  const finders = row ? (row.finders.length ? row.finders : parent?.finders ?? []) : [];
  const judged = findings.some((f) => markable(f));

  // The open finding: the address's ("none" when the person shut it), else the newest of the first group.
  const first = (asks[0]?.signal as FinderSignal | undefined) ?? groups[0]?.findings[0] ?? null;
  const open = selection.finding ? findings.find((f) => f._id === selection.finding || f.short_id === selection.finding) ?? null : first;
  // Opening a finding is a step Back closes; shutting one only rewrites the entry (the problem page does the same).
  // The finding the page was opened on by its address, held from the first paint: that one is brought into view.
  const [arrivedOn] = useState(() => (selection.finding && selection.finding !== "none" ? selection.finding : null));
  const toggle = (f: FinderSignal) => { const shut = open?._id === f._id; select({ finding: shut ? "none" : f.short_id ?? f._id }, undefined, shut ? { replace: true } : { push: true }); };

  // The way back, on the title's line: the finder's name is said once, as the page's heading.
  const crumb = (
    <nav className="fp-crumb" aria-label="Where this finder is">
      <a className="fp-crumb-link" href={href({ view: "line", source: null, finding: null, step: null })} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select({ view: "line", source: null, finding: null, step: null }); }}>Steps</a>
      <span aria-hidden>›</span>
    </nav>
  );
  if (!row) {
    // Until the floor's findings have loaded, a named finder is not missing yet.
    if (!workspace.ready) return <div className="lw-skeleton" aria-busy data-line-view="finder">{[40, 92, 70, 54].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>;
    return (
      <div className="fp" data-line-view="finder" data-line-finder-missing={selection.source ?? ""}>
        <header className="fp-head"><div className="fp-titlerow">{crumb}<h1 className="fp-title">Finder</h1></div></header>
        <div className="lw-empty"><b>No finder by that name filed here</b>It may file into another process.</div>
      </div>
    );
  }
  // The Find table's figure for this row, so the number clicked is the number here.
  const week = stat?.week ?? findings.filter((f) => findingAt(f) >= window.from).length;
  const rate = stat ? wrongRateWords(stat) : null;
  // What it looks for, in a reader's words. How it groups and when its job files are the filer's plumbing, not this page's.
  const purpose = finders.length ? [...new Set(finders.map((f) => `Looks for ${watchesFor(f.kind)}`))] : [];

  return (
    <div className="fp" data-line-view="finder" data-line-finder={row.key}>
      <header className="fp-head">
        <div className="fp-titlerow">{crumb}<h1 className="fp-title">{row.name}</h1></div>
        {purpose.map((p) => <p key={p} className="fp-purpose">{p}</p>)}
        <dl className="fp-figures">
          <div><dt>{window.cut ? `Findings, last ${windowWords}` : "Findings this week"}</dt><dd className="lw-num">{week}</dd></div>
          {judged && <div data-line-finder-wrong-rate><dt>Wrong rate</dt><dd className="lw-num">{stat?.wrong ? rate : "0%"}</dd></div>}
        </dl>
      </header>

      {!groups.length ? (
        // A line's own judge listed under a picked project it filed nothing into: its findings are a press away.
        workspace.project && elsewhere.get(row.key) ? (
          <div className="lw-empty" data-line-finder-elsewhere={elsewhere.get(row.key)}>
            <b>None in {workspace.project.title}</b>
            <button type="button" className="lw-act" onClick={() => select({ project: null })}>All projects<span className="lw-num">{elsewhere.get(row.key)}</span></button>
          </div>
        ) : <div className="lw-empty"><b>No findings held</b>Nothing from {row.name} is in the window the line holds.</div>
      ) : (
        <div className="fp-body">
          {asks.length > 0 && <TeamAsks asks={asks} open={open?._id ?? null} toggle={toggle} who={who as unknown as (s: FinderSignal) => string} tasks={tasks} onProblem={(id) => select({ view: "problems", case: id, run: null, source: null, finding: null })} problemHref={(id) => href({ view: "problems", case: id, run: null, source: null, finding: null })} />}
          {groups.map((g) => <Group key={g.key} group={g} open={open?._id ?? null} arrived={arrivedOn} toggle={toggle} who={who as unknown as (s: FinderSignal) => string} tasks={tasks} onProblem={(id) => select({ view: "problems", case: id, run: null, source: null, finding: null })} problemHref={(id) => href({ view: "problems", case: id, run: null, source: null, finding: null })} />)}
        </div>
      )}
    </div>
  );
}

function Group({ group: g, open, arrived, toggle, who, tasks, onProblem, problemHref }: {
  group: FinderGroup<FinderSignal>; open: string | null; arrived: string | null; toggle: (f: FinderSignal) => void; who: (s: FinderSignal) => string;
  tasks: ReadonlyMap<string, { _id: string; short_id?: string; title: string }>; onProblem: (id: string) => void; problemHref: (id: string) => string;
}) {
  const [all, setAll] = useStateLimit(g.findings.length, open ? g.findings.findIndex((f) => f._id === open) + 1 : 0);
  const shown = g.findings.slice(0, all);
  // Arriving on a finding the address names (the Find table's Not filed cell) brings its group into view, once.
  const box = useRef<HTMLElement>(null);
  const holds = !!arrived && g.findings.some((f) => f._id === arrived || f.short_id === arrived);
  useMountEffect(() => { if (holds) box.current?.scrollIntoView({ block: "start", behavior: "instant" as ScrollBehavior }); });
  return (
    <section ref={box} className="fp-group" data-line-finder-group={g.key}>
      {/* Each group's count is the one figure for its label, over the Find table's window, so the table's
          Not filed is the count here. */}
      <h2 className="fp-h">{g.label}<span className="lw-num fp-h-n">{g.findings.length}</span></h2>
      <ul className="fp-list">
        {shown.map((f) => {
          const t = f.task_id ? tasks.get(f.task_id) : null;
          return (
            <Fragment key={f._id}>
              <FindingReader signal={f as never} who={who(f)} open={open === f._id} onToggle={() => toggle(f)} />
              {open === f._id && t && (
                <li className="fp-problem-row"><a className="fp-problem" href={problemHref(t._id)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); onProblem(t._id); }} data-line-finding-problem={t.short_id ?? t._id}>
                  <span className="fp-problem-k">Filed to</span><span className="lw-mono">{t.short_id ?? "Problem"}</span><span>{t.title}</span>
                </a></li>
              )}
            </Fragment>
          );
        })}
      </ul>
      {g.findings.length > shown.length && <button type="button" className="lw-link fp-more" onClick={() => setAll(Math.min(g.findings.length, shown.length + PAGE * 2))}>{moreWords(PAGE * 2, g.findings.length - shown.length)}</button>}
    </section>
  );
}

/** What the finder's findings ask the team to do by a date, grouped by what they ask about (askCauses): a cause asked
 *  about several contacts is one heading with one "Make this a problem (N asks)…" that files its unfiled asks as one
 *  problem. Each row: when, the act and what it is about (opens the agent's words in place), whom it is for (the
 *  problem it is filed to and that problem's assignee; nobody until it is filed), and the product's task to do it in.
 *  Whether it was done is the product's to say, so a passed date reads "Was due", never late, and nothing marks it done. */
function TeamAsks({ asks, open, toggle, who, tasks, onProblem, problemHref }: {
  asks: TeamAsk<FinderSignal & AskSignal>[]; open: string | null; toggle: (f: FinderSignal) => void; who: (s: FinderSignal) => string;
  tasks: ReadonlyMap<string, { _id: string; short_id?: string; title: string; status?: string; assignee?: string | null }>; onProblem: (id: string) => void; problemHref: (id: string) => string;
}) {
  const now = Date.now();
  const causes = useMemo(() => askCauses(asks), [asks]);
  const members = useInboxStore((st) => st.teamMembers) as Array<{ _id: string; name?: string | null }> | undefined;
  const me = useInboxStore((st) => st.currentUser?._id ?? null);
  const [making, setMaking] = useState<AskCause<FinderSignal & AskSignal> | null>(null);
  const [made, setMade] = useState<Record<string, { id: string; ref: string | null } | { error: string }>>({});
  const owner = (assignee: string | null | undefined) => !assignee ? "No owner" : String(assignee) === String(me) ? "You" : members?.find((m) => String(m._id) === String(assignee))?.name ?? "Someone";
  const row = (a: TeamAsk<FinderSignal & AskSignal>) => {
    const due = dueWords(a.due, now);
    const t = a.signal.task_id ? tasks.get(a.signal.task_id) : null;
    return (
      <Fragment key={a.signal._id}>
        <li className="fp-ask" data-line-team-ask={a.signal.short_id ?? a.signal._id}>
          <span className="fp-ask-due" data-past={due.past ? "" : undefined}>{due.short}</span>
          <button type="button" className="fp-ask-title" aria-expanded={open === a.signal._id} onClick={() => toggle(a.signal)}>{a.title}</button>
          <span className="fp-ask-for" data-line-team-ask-owner>
            {t ? <a className="lw-link" href={problemHref(t._id)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); onProblem(t._id); }}>{t.short_id ?? "Problem"}</a> : null}
            <span data-none={!t?.assignee ? "" : undefined}>{owner(t?.assignee)}</span>
          </span>
          {a.url && open !== a.signal._id && <a className="lw-link fp-ask-open" href={a.url} target="_blank" rel="noreferrer" data-line-team-ask-open>{evidenceLinkWords(a.url)} ↗</a>}
        </li>
        {open === a.signal._id && <FindingReader signal={a.signal as never} who={who(a.signal)} open onToggle={() => toggle(a.signal)} />}
      </Fragment>
    );
  };
  // The open problem every filed ask of a group sits on, when they agree: the rest join it rather than open its twin.
  const homeOf = (c: AskCause<FinderSignal & AskSignal>) => {
    const ids = [...new Set(c.asks.map((a) => a.signal.task_id).filter((x): x is string => !!x))];
    const t = ids.length === 1 ? tasks.get(ids[0]) : null;
    return t && !/^(done|dropped|closed|cancel)/i.test(t.status ?? "") ? t : null;
  };
  const make = (c: AskCause<FinderSignal & AskSignal>) => {
    const unfiled = c.asks.filter((a) => !a.signal.task_id).map((a) => a.signal._id);
    setMaking(null);
    useInboxStore.getState().makeProblemOfFinding(unfiled[0], unfiled.slice(1), c.about, homeOf(c)?._id)
      .then((r) => setMade((m) => ({ ...m, [c.key]: r ? { id: r.task_id, ref: r.task_short_id } : { error: "The server did not answer" } })))
      .catch((e: unknown) => setMade((m) => ({ ...m, [c.key]: { error: (e instanceof Error ? e.message : String(e)).replace(/^.*ConvexError:\s*/, "").split("\n")[0] || "The server refused it" } })));
  };
  return (
    <section className="fp-group" data-line-finder-group="asks">
      <h2 className="fp-h">Team asks<span className="lw-num fp-h-n">{asks.length}</span></h2>
      {causes.map((c) => {
        if (c.asks.length === 1) return <ul key={c.key} className="fp-list">{row(c.asks[0])}</ul>;
        const unfiled = c.asks.filter((a) => !a.signal.task_id);
        const done = made[c.key];
        return (
          <div key={c.key} className="fp-cause" data-line-ask-cause={c.asks.length}>
            <div className="fp-cause-head">
              <b className="fp-cause-about">{c.about}</b>
              <span className="lw-num fp-h-n">{c.asks.length} asks</span>
              {done && "id" in done ? (
                <button type="button" className="lw-link" onClick={() => onProblem(done.id)} data-line-ask-cause-made={done.ref ?? done.id}>Filed to {done.ref ?? "a new problem"}</button>
              ) : unfiled.length > 0 && (
                <>
                  {done && "error" in done && <span className="lw-act-error" role="alert">{done.error}</span>}
                  <button type="button" className="lw-act" aria-haspopup="dialog" onClick={() => setMaking(c)} data-line-ask-cause-make={unfiled.length}>
                    {`${homeOf(c) ? `File into ${homeOf(c)!.short_id ?? "its problem"}` : "Make this a problem"} (${unfiled.length} ${unfiled.length === 1 ? "ask" : "asks"})…`}
                  </button>
                </>
              )}
            </div>
            <ul className="fp-list">{c.asks.map(row)}</ul>
          </div>
        );
      })}
      {making && (
        <SwitchReview
          ledger={askCauseLedger({
            cause: making.about,
            unfiled: making.asks.filter((a) => !a.signal.task_id).map((a) => escalationFinding(a.signal)?.contact ?? a.title),
            filed: making.asks.filter((a) => !!a.signal.task_id).length,
            into: homeOf(making)?.short_id ?? null,
          })}
          onClose={() => setMaking(null)} onConfirm={() => make(making)} />
      )}
    </section>
  );
}

/** A page size that grows to hold the open row. */
function useStateLimit(total: number, mustHold: number): [number, (n: number) => void] {
  const [n, setN] = useState(PAGE);
  return [Math.min(total, Math.max(n, mustHold)), setN];
}
