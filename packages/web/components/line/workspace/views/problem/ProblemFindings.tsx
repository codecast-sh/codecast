"use client";
// The findings of one problem (line-journeys.md LJ8.3, J4): the count, and
// each finding as a row (who, when, what) that opens the real thing in place
// (FindingReader), newest first, the first open on arrival. One divider
// separates what came after the fix from what came before.
import { useMemo, useState } from "react";
import { findingLeads, misfiledAsks } from "../../../../../lib/line/problemPage";
import { repeatedFindings, repeatKey } from "../../../../../lib/line/findingEvidence";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { FindingPlaceholder, FindingReader, useFinderName, type ReaderSignal } from "../../../widgets/FindingReader";

/** A list this short shows whole. */
const ALL_UP_TO = 20;
/** Open at once at most: each open judge finding frames the product's own screen. */
const OPEN_MAX = 3;

export type FixMark = { at: number; words: string; /** Findings after it count against the fix: it is in production. */ live: boolean };

export function ProblemFindings({ signals, expected, ready, fix, home, finding, onFinding, title, problem, doubt, emptied }: {
  signals: ReadonlyArray<ReaderSignal>;
  /** The problem's title, as the page heads it: a row never says it again. */
  title: string;
  /** How many the problem holds: rows the feed has not brought yet draw as placeholders. */
  expected: number;
  ready: boolean;
  /** The newest fix: where the divider sits and what it says. */
  fix: FixMark | null;
  /** The expectation the problem is about: a later finding citing another is about something else. */
  home: string | null;
  /** The finding the address names (its short id). */
  finding: string | null;
  onFinding: (ref: string | null) => void;
  /** The problem's ref: a finding can be moved out of it ("Not this problem"). */
  problem: string | null;
  /** Grounding doubts the findings match the problem (lineTrace causeDoubt): its note. */
  doubt: string | null;
  /** Findings were moved out of it: with none left it has no supporting finding, it was not filed by hand. */
  emptied: boolean;
}) {
  const who = useFinderName();
  // A finding filed twice word for word is one row, "×2", and one in the count.
  const { rows, asks, times } = useMemo(() => {
    const repeats = repeatedFindings(signals);
    const n = new Map<string, number>();
    for (const s of repeats) n.set(repeatKey(s), (n.get(repeatKey(s)) ?? 0) + 1);
    const kept = signals.filter((s) => !repeats.has(s)).sort((a, b) => (b.observed_at || b.created_at) - (a.observed_at || a.created_at));
    // A person's ask filed here by word overlap is not evidence of this problem: it sits apart, below.
    const apart = misfiledAsks(kept);
    return { rows: kept.filter((s) => !apart.has(s)), asks: kept.filter((s) => apart.has(s)), times: (s: ReaderSignal) => (repeats.size ? 1 + (n.get(repeatKey(s)) ?? 0) : 1) };
  }, [signals]);
  const refOf = (s: ReaderSignal) => s.short_id ?? s._id;
  // The first is open on arrival; the address names another; a person opens up to three.
  const [opened, setOpened] = useState<string[] | null>(null);
  const first = rows[0] ? refOf(rows[0]) : null;
  const open = opened ?? (finding ? [finding] : first ? [first] : []);
  useWatchEffect(() => { if (finding && opened && !opened.includes(finding)) setOpened([...opened, finding].slice(-OPEN_MAX)); }, [finding]);
  const toggle = (ref: string) => {
    const next = open.includes(ref) ? open.filter((x) => x !== ref) : [...open, ref].slice(-OPEN_MAX);
    setOpened(next);
    onFinding(next.includes(ref) ? ref : next[next.length - 1] ?? null);
  };
  const [all, setAll] = useState(false);
  const pinned = finding ? rows.findIndex((s) => refOf(s) === finding) : -1;
  const shown = all || rows.length <= ALL_UP_TO || pinned >= ALL_UP_TO ? rows : rows.slice(0, ALL_UP_TO);
  // No row says the page's title again, and rows that share a title lead with what each finder says.

  // A finding leaves with every finding of the problem under its key: the review says how many.
  const byKey = useMemo(() => { const m = new Map<string, number>(); for (const s of signals) if (s.fingerprint) m.set(s.fingerprint, (m.get(s.fingerprint) ?? 0) + 1); return m; }, [signals]);
  const leadOf = useMemo(() => findingLeads(rows, title), [rows, title]);
  const total = Math.max(expected - (signals.length - rows.length), rows.length);
  const moveOf = (s: ReaderSignal, misfiled = false) => (problem && s.task_id ? { problem, count: (s.fingerprint && byKey.get(s.fingerprint)) || 1, left: Math.max(0, total + asks.length - ((s.fingerprint && byKey.get(s.fingerprint)) || 1)), misfiled } : null);
  const waiting = !ready && rows.length < expected;
  const dividerAt = fix ? shown.findIndex((s) => (s.observed_at || s.created_at) < fix.at) : -1;
  // Nothing here supports the problem: its only finding is doubted, or every one was moved out.
  const unsupported = (doubt != null && total === 1) || (total === 0 && emptied);

  return (
    <section className="pf" data-line-findings={total} aria-label="Findings">
      <header className="pp-sec-h">
        <h3>Findings <span className="lw-num">{total}</span></h3>
        {unsupported && <span className="pf-unsupported" title={doubt ?? undefined} data-line-findings-unsupported>No supporting finding</span>}
      </header>
      {total === 0 ? (!emptied && <span className="pp-none">Filed by hand</span>) : (
        <ul className="pf-list">
          {shown.map((s, i) => {
            const ref = refOf(s);
            const since = !!fix?.live && (s.observed_at || s.created_at) >= fix.at;
            const lead = leadOf(s);
            return (
              <FragmentRow key={s._id} divider={fix && i === dividerAt ? fix.words : null}>
                <FindingReader signal={s} who={who(s)} open={open.includes(ref)} onToggle={() => toggle(ref)} lead={lead} expectation={title} moveOut={moveOf(s)} since={since} off={since && !!home && !!s.subject && s.subject !== home} times={times(s)} />
              </FragmentRow>
            );
          })}
          {fix && dividerAt < 0 && shown.length > 0 && !waiting && shown.length === rows.length && <li className="pf-divider" data-line-findings-divider>{fix.words}</li>}
          {waiting && Array.from({ length: Math.min(6, expected - rows.length) }, (_, i) => <FindingPlaceholder key={`w${i}`} />)}
        </ul>
      )}
      {rows.length > shown.length && <button type="button" className="lw-link pp-more" onClick={() => setAll(true)}>Show all {rows.length}</button>}
      {asks.length > 0 && (
        // Someone's ask, filed here by word overlap: read whole in place, and moved out as the main act.
        <div className="pf-apart" data-line-findings-apart={asks.length}>
          <h4 className="pp-sec-h">Probably not this problem <span className="lw-num">{asks.length}</span></h4>
          <ul className="pf-list">
            {asks.map((s) => {
              const ref = refOf(s);
              return <FindingReader key={s._id} signal={s} who={who(s)} open={open.includes(ref)} onToggle={() => toggle(ref)} lead={leadOf(s)} expectation={title} moveOut={moveOf(s, true)} times={times(s)} />;
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function FragmentRow({ divider, children }: { divider: string | null; children: React.ReactNode }) {
  return <>{divider && <li className="pf-divider" data-line-findings-divider>{divider}</li>}{children}</>;
}
