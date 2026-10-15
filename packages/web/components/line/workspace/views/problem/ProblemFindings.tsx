"use client";
// The findings of one problem (line-journeys.md LJ8.3, J4): the count, and
// each finding as a row (who, when, what) that opens the real thing in place
// (FindingReader), newest first, the first open on arrival. One divider
// separates what came after the fix from what came before.
import { useMemo, useRef, useState } from "react";
import { findingLeads, misfiledAsks } from "../../../../../lib/line/problemPage";
import { isEmptyFinding, offTopicFindings, repeatedFindings, repeatKey } from "../../../../../lib/line/findingEvidence";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { FindingPlaceholder, FindingReader, useFinderName, type ReaderSignal } from "../../../widgets/FindingReader";

/** A list this short shows whole. */
const ALL_UP_TO = 20;
/** Open at once at most: each open judge finding frames the product's own screen. */
const OPEN_MAX = 3;

export type FixMark = { at: number; words: string; /** Findings after it count against the fix: it is in production. */ live: boolean };

export function ProblemFindings({ signals, expected, ready, fix, home, back, finding, onFinding, title, problem, doubt, emptied }: {
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
  /** Findings that came back from a problem merged into this one (problemPage cameBack): by id, that problem's ref. */
  back?: ReadonlyMap<string, string>;
  /** The finding the address names (its short id). */
  finding: string | null;
  /** `opened`: a click opened `ref` (a history entry, so Back closes it); else one was closed (the entry is rewritten). */
  onFinding: (ref: string | null, opened: boolean) => void;
  /** The problem's ref: a finding can be moved out of it ("Not this problem"). */
  problem: string | null;
  /** Grounding doubts the findings match the problem (lineTrace causeDoubt): its note. */
  doubt: string | null;
  /** Findings were moved out of it: with none left it has no supporting finding, it was not filed by hand. */
  emptied: boolean;
}) {
  const who = useFinderName();
  // A finding filed twice word for word is one row, "×2", and one in the count.
  // A finding that says nothing is no row and no count: one line says how many there are.
  const { rows, asks, times, empty } = useMemo(() => {
    const repeats = repeatedFindings(signals);
    const n = new Map<string, number>();
    for (const s of repeats) n.set(repeatKey(s), (n.get(repeatKey(s)) ?? 0) + 1);
    const empty = signals.filter(isEmptyFinding).length;
    const kept = signals.filter((s) => !repeats.has(s) && !isEmptyFinding(s)).sort((a, b) => (b.observed_at || b.created_at) - (a.observed_at || a.created_at));
    // A person's ask filed here by word overlap is not evidence of this problem, nor is a finding about something else
    // under a title that rests on nothing: each sits apart, below, its move out first.
    const off = offTopicFindings(title, signals);
    const apart = new Set([...misfiledAsks(kept), ...off]);
    return { rows: kept.filter((s) => !apart.has(s)), asks: kept.filter((s) => apart.has(s)), times: (s: ReaderSignal) => (repeats.size ? 1 + (n.get(repeatKey(s)) ?? 0) : 1), empty };
  }, [signals, title]);
  const refOf = (s: ReaderSignal) => s.short_id ?? s._id;
  // Every finding is one line on arrival (one can hold a whole call); the address may name one open; a person opens up to three.
  const [opened, setOpened] = useState<string[] | null>(null);
  // With nothing listed, the first finding apart opens: its move out is the act.
  const first = rows[0] ? null : asks[0] ? refOf(asks[0]) : null;
  const open = opened ?? (finding ? [finding] : first ? [first] : []);
  // The address moving on its own (Back, Forward, a link) sets what is open: as it reads on arrival at that address.
  const wrote = useRef(finding);
  useWatchEffect(() => {
    if (finding === wrote.current) return;
    wrote.current = finding;
    setOpened(null);
  }, [finding]);
  const toggle = (ref: string) => {
    const opening = !open.includes(ref);
    const next = opening ? [...open, ref].slice(-OPEN_MAX) : open.filter((x) => x !== ref);
    setOpened(next);
    // Every one closed is said too ("none"), or a reload would open the first again.
    wrote.current = opening ? ref : next[next.length - 1] ?? "none";
    onFinding(wrote.current, opening);
  };
  const [all, setAll] = useState(false);
  const pinned = finding ? rows.findIndex((s) => refOf(s) === finding) : -1;
  const shown = all || rows.length <= ALL_UP_TO || pinned >= ALL_UP_TO ? rows : rows.slice(0, ALL_UP_TO);
  // No row says the page's title again, and rows that share a title lead with what each finder says.

  // A finding leaves with every finding of the problem under its key: the review says how many.
  const byKey = useMemo(() => { const m = new Map<string, number>(); for (const s of signals) if (s.fingerprint) m.set(s.fingerprint, (m.get(s.fingerprint) ?? 0) + 1); return m; }, [signals]);
  const leadOf = useMemo(() => findingLeads(rows, title), [rows, title]);
  const total = Math.max(expected - (signals.length - rows.length), rows.length);
  // Off the list but still the problem's: a finding apart is shown below, an empty one is the count line.
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
      {total === 0 ? (!emptied && !empty && !asks.length && <span className="pp-none">Filed by hand</span>) : (
        <ul className="pf-list">
          {shown.map((s, i) => {
            const ref = refOf(s);
            const since = !!fix?.live && (s.observed_at || s.created_at) >= fix.at;
            const lead = leadOf(s);
            return (
              <FragmentRow key={s._id} divider={fix && i === dividerAt ? fix.words : null}>
                <FindingReader signal={s} who={who(s)} open={open.includes(ref)} onToggle={() => toggle(ref)} lead={lead} expectation={title} moveOut={moveOf(s)} since={since} off={since && !!home && !!s.subject && s.subject !== home} back={back?.get(s._id) ?? null} times={times(s)} />
              </FragmentRow>
            );
          })}
          {fix && dividerAt < 0 && shown.length > 0 && !waiting && shown.length === rows.length && <li className="pf-divider" data-line-findings-divider>{fix.words}</li>}
          {waiting && Array.from({ length: Math.min(6, expected - rows.length) }, (_, i) => <FindingPlaceholder key={`w${i}`} />)}
        </ul>
      )}
      {rows.length > shown.length && <button type="button" className="lw-link pp-more" onClick={() => setAll(true)}>Show all {rows.length}</button>}
      {empty > 0 && <p className="pp-none pf-empty" data-line-findings-empty={empty}><b className="lw-num">{empty}</b> empty, not listed</p>}
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
