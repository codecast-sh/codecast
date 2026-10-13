"use client";
// The findings of one problem (line-journeys.md LJ8.3, J4): the count, and
// each finding as a row (who, when, what) that opens the real thing in place
// (FindingReader), newest first, the first open on arrival. One divider
// separates what came after the fix from what came before.
import { useMemo, useState } from "react";
import { findingTitle } from "../../../../../lib/line/loopSteps";
import { findingBlocks } from "../../../../../lib/line/problemPage";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { FindingPlaceholder, FindingReader, useFinderName, type ReaderSignal } from "../../../widgets/FindingReader";

/** A list this short shows whole. */
const ALL_UP_TO = 20;
/** Open at once at most: each open judge finding frames the product's own screen. */
const OPEN_MAX = 3;

export type FixMark = { at: number; words: string; /** Findings after it count against the fix: it is in production. */ live: boolean };

export function ProblemFindings({ signals, expected, ready, fix, home, finding, onFinding, title }: {
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
}) {
  const who = useFinderName();
  const rows = useMemo(() => [...signals].sort((a, b) => (b.observed_at || b.created_at) - (a.observed_at || a.created_at)), [signals]);
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
  // Findings of one problem often share a title (an expectation's words): each row then leads with what its finder says.
  const sameTitle = useMemo(() => rows.length > 1 && new Set(rows.map((s) => findingTitle(s))).size < rows.length, [rows]);
  const said = (t: string) => t.toLowerCase().replace(/[\s.…]+$/g, "").replace(/\s+/g, " ");
  const pageSays = said(title);
  const total = Math.max(expected, rows.length);
  const waiting = !ready && rows.length < expected;
  const dividerAt = fix ? shown.findIndex((s) => (s.observed_at || s.created_at) < fix.at) : -1;

  return (
    <section className="pf" data-line-findings={total} aria-label="Findings">
      <header className="pp-sec-h">
        <h3>Findings <span className="lw-num">{total}</span></h3>
      </header>
      {total === 0 ? <span className="pp-none">Filed by hand</span> : (
        <ul className="pf-list">
          {shown.map((s, i) => {
            const ref = refOf(s);
            const since = !!fix?.live && (s.observed_at || s.created_at) >= fix.at;
            // A judge's finding leads with its own title (the moment shows the rest); any other leads with its first paragraph.
            // A finding titled as the page is (a problem filed from it) leads with what it says too.
            const lead = (sameTitle || said(findingTitle(s)) === pageSays) && !s.moment ? findingBlocks(s).find((b) => b.kind === "text")?.text ?? "" : null;
            return (
              <FragmentRow key={s._id} divider={fix && i === dividerAt ? fix.words : null}>
                <FindingReader signal={s} who={who(s)} open={open.includes(ref)} onToggle={() => toggle(ref)} lead={lead} since={since} off={since && !!home && !!s.subject && s.subject !== home} />
              </FragmentRow>
            );
          })}
          {fix && dividerAt < 0 && shown.length > 0 && !waiting && shown.length === rows.length && <li className="pf-divider" data-line-findings-divider>{fix.words}</li>}
          {waiting && Array.from({ length: Math.min(6, expected - rows.length) }, (_, i) => <FindingPlaceholder key={`w${i}`} />)}
        </ul>
      )}
      {rows.length > shown.length && <button type="button" className="lw-link pp-more" onClick={() => setAll(true)}>Show all {rows.length}</button>}
    </section>
  );
}

function FragmentRow({ divider, children }: { divider: string | null; children: React.ReactNode }) {
  return <>{divider && <li className="pf-divider" data-line-findings-divider>{divider}</li>}{children}</>;
}
