// A run as one story: everything it produced, from every place it happened,
// on one line in the run's own time, with the markers that provoked it (a
// scripted beat) in place. It reads the whole run in the order things
// happened, which is the only view that shows an email landing in the middle
// of a chat argument. Generalised from union's admin/sim StoryFeed: a host
// builds the items (placing each on the run's clock with calibrateOffsetMs
// and onRunClock) and draws each body; the timeline orders them, rules the
// days, filters by lane and folds long bodies. A host shows it as one of its
// run panels.

import { useMemo, useState, type ReactNode } from "react";
import { dayIn, laneCounts, orderTimeline, runClockLabel, type TimeLike } from "../../client";
import { useEvalsHost } from "../hooks";

export type TimelineTone = "magenta" | "cyan" | "violet" | "red" | "yellow" | "blue" | "orange" | "green";

export interface TimelineItem {
  id: string;
  /** When it happened, on the run's clock. */
  at: TimeLike;
  /** Which filter it falls under: "slack", "email". */
  lane: string;
  /** A marker in the story (a scripted beat): drawn as a rule with these words, and no body. */
  marker?: string;
  /** Where it happened, in the rail: "#union", "Dana Whitfield". */
  where?: string;
  /** What situates that place: its team, an email's subject. */
  context?: string | null;
  /** An accent for the place, so one team's rooms read alike. */
  tone?: TimelineTone | null;
  /** What was said, as the host draws it. */
  body?: ReactNode;
  /** The body's length in characters: past the timeline's clamp it is folded until opened. Without it a body is never folded. */
  length?: number;
}

export interface TimelineProps {
  items: readonly TimelineItem[];
  /** The run's start: days are counted from it. */
  origin: TimeLike;
  /** The lanes in the order the filter offers them, after "everything". A lane with nothing in it is not offered. */
  lanes?: Array<{ key: string; label: string }>;
  title?: string;
  note?: string;
  /** Bodies longer than this fold, so one monologue cannot bury the line. */
  clampChars?: number;
}

const ALL = "all";

export function Timeline({ items, origin, lanes, title = "Story", note = "everything the run produced, in the order it happened", clampChars = 700 }: TimelineProps) {
  const { SegmentedToggle } = useEvalsHost().ui;
  const [lane, setLane] = useState(ALL);
  const rows = useMemo(() => orderTimeline(items), [items]);
  const counts = useMemo(() => laneCounts(rows), [rows]);
  const offered = useMemo(() => {
    const named = lanes ?? Object.keys(counts).map((key) => ({ key, label: key }));
    return [{ key: ALL, label: "everything", count: rows.length }, ...named.filter((l) => counts[l.key]).map((l) => ({ ...l, count: counts[l.key] }))];
  }, [lanes, counts, rows.length]);
  const shown = offered.some((l) => l.key === lane) ? lane : ALL;
  const visible = shown === ALL ? rows : rows.filter((r) => r.lane === shown);

  if (!rows.length) return null;
  let lastDay = Number.NaN;
  return (
    <section className="ev-section ev-tl" data-ev-timeline>
      <div className="ev-tl-head">
        <h2 className="ev-title">
          {title}
          <span className="ev-title-note">{note}</span>
        </h2>
        <span className="ev-grow" />
        {offered.length > 2 && <SegmentedToggle value={shown} onChange={setLane} items={offered} />}
      </div>
      <div className="ev-card ev-tl-body">
        {visible.map((row) => {
          const day = dayIn(origin, row.at);
          const newDay = day !== lastDay;
          lastDay = day;
          return (
            <div key={row.id}>
              {newDay && (
                <div className="ev-tl-day" data-ev-timeline-day={day}>
                  <span>Day {day}</span>
                  <span className="ev-tl-rule" />
                </div>
              )}
              <TimelineRow row={row} origin={origin} clampChars={clampChars} />
            </div>
          );
        })}
        {!visible.length && <div className="ev-empty-note">Nothing in this lane.</div>}
      </div>
    </section>
  );
}

function TimelineRow({ row, origin, clampChars }: { row: TimelineItem; origin: TimeLike; clampChars: number }) {
  const [open, setOpen] = useState(false);
  const when = runClockLabel(origin, row.at);
  if (row.marker) {
    return (
      <div className="ev-tl-marker" data-ev-timeline-item={row.id} data-ev-timeline-marker>
        <span className="ev-tl-when ev-mono">{when}</span>
        <span className="ev-tl-marker-text ev-mono">{row.marker}</span>
        <span className="ev-tl-marker-rule" />
      </div>
    );
  }
  const long = (row.length ?? 0) > clampChars;
  return (
    <div className="ev-tl-row" data-ev-timeline-item={row.id} data-ev-timeline-lane={row.lane}>
      <div className="ev-tl-rail">
        <span className="ev-tl-when ev-mono">{when}</span>
        {row.where && (
          <span className="ev-chip ev-tl-where" data-ev-tone={row.tone ?? undefined} title={row.context ? `${row.where}, ${row.context}` : row.where}>
            {row.where}
          </span>
        )}
        {row.context && (
          <span className="ev-tl-context" data-ev-tone={row.tone ?? undefined} title={row.context}>
            {row.context}
          </span>
        )}
      </div>
      <div className="ev-tl-main">
        <div className={long && !open ? "ev-tl-folded" : undefined}>{row.body}</div>
        {long && (
          <button type="button" className="ev-tl-more ev-mono" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "show less" : "show more"}
          </button>
        )}
      </div>
    </div>
  );
}
