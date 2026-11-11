import { useRef, useState } from "react";
import Link from "next/link";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { getLabelColor } from "../../lib/labelColors";
import { Spinner } from "../ui/spinner";
import { SessionStatusMark } from "../inbox/SessionStatusMark";
import { ActivityRow } from "./ActivityRow";
import { DecisionChip, Face, PrChip, TaskChip } from "./ActivityParts";
import type { ActivityDay, ActivityGroup, ActivityGroupBy, ActivityItem } from "./activityModel";

// The body of the Activity page: what waits on someone, pinned first,
// then what happened, by day and inside a day by person or project. A group
// leads with what it produced (PRs, tasks done, answers) and shows a few of
// its sessions, one line each; the rest are a press away.

const GROUP_ROWS = 5;
const NEEDS_ROWS = 3;
const GROUP_OUTCOMES = 6;

export function ActivityNeedsGroup({ items, all = false, teamId }: { items: ActivityItem[]; all?: boolean; teamId: string | null }) {
  const [more, setMore] = useState(false);
  const shown = all || more ? items : items.slice(0, NEEDS_ROWS);
  return (
    <section data-activity-needs aria-label="Needs someone" className="mb-6">
      <div className="mb-1 flex h-7 items-center gap-2">
        <SessionStatusMark status="needs_you" />
        <h2 className="text-ui font-semibold text-sol-text">Needs someone</h2>
        <span className="text-meta tabular-nums text-sol-text-dim">{items.length}</span>
      </div>
      <ul className="rounded-lg border border-sol-border/40 bg-sol-card px-1 py-1 modern:rounded-card modern:border-sol-border">
        {shown.map((item) => (
          <ActivityRow key={item.id} item={item} relative needsRow showActor teamId={teamId} />
        ))}
      </ul>
      {shown.length < items.length && (
        <button type="button" onClick={() => setMore(true)} className="mt-1 h-7 rounded-md px-2 text-meta text-sol-text-muted hover:bg-sol-text/[0.04] hover:text-sol-text modern:rounded-control">
          Show {items.length - shown.length} more
        </button>
      )}
    </section>
  );
}

export function ActivityDays({ days, by, teamId, personHref, projectHref }: {
  days: ActivityDay[];
  by: ActivityGroupBy;
  teamId: string | null;
  personHref: (id: string) => string;
  projectHref: (name: string) => string;
}) {
  return (
    <div data-activity-days>
      {days.map((day, i) => (
        <section key={day.date} data-activity-day={day.date} aria-label={day.label} className="mb-4">
          <h2 className="sticky top-0 z-10 -mx-1 flex h-9 items-center gap-2 bg-sol-bg px-1">
            <span className="text-ui font-semibold text-sol-text-muted">{day.label}</span>
            <span className="text-meta tabular-nums text-sol-text-dim">
              {day.sessions} {day.sessions === 1 ? "session" : "sessions"}
              {day.people > 1 ? ` · ${day.people} people` : ""}
            </span>
            <span aria-hidden className="h-px flex-1 bg-sol-border" />
          </h2>
          {day.groups.map((group) => (
            <ActivityGroupBlock
              key={group.key}
              group={group}
              by={by}
              relative={i === 0 && day.label === "Today"}
              teamId={teamId}
              href={group.actor ? personHref(group.actor.id) : group.project ? projectHref(group.project) : null}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function ActivityGroupBlock({ group, by, relative, teamId, href }: {
  group: ActivityGroup;
  by: ActivityGroupBy;
  relative: boolean;
  teamId: string | null;
  href: string | null;
}) {
  const [allRows, setAllRows] = useState(false);
  const [allOutcomes, setAllOutcomes] = useState(false);
  const rows = allRows ? group.items : group.items.slice(0, GROUP_ROWS);
  const outcomes = [
    ...group.prs.map((p) => <PrChip key={`pr:${p.key}`} pr={p} withTitle />),
    ...group.tasksDone.map((t) => <TaskChip key={`t:${t.id}`} task={t} withTitle />),
    ...group.decisionsAnswered.map((d) => <DecisionChip key={`d:${d.id}`} decision={d} sessionId={group.items[0]?.id ?? ""} />),
  ];
  const shownOutcomes = allOutcomes ? outcomes : outcomes.slice(0, GROUP_OUTCOMES);
  const name = (
    <>
      {group.actor ? <Face actor={group.actor} size={20} /> : <span aria-hidden className={`size-2 shrink-0 rounded-full ${group.project ? getLabelColor(group.project).dot : "bg-sol-text-dim"}`} />}
      <span className={`min-w-0 truncate text-ui font-semibold text-sol-text ${group.project ? "font-mono" : ""}`}>{group.label}</span>
    </>
  );
  return (
    <div data-activity-group={group.key} className="mb-3">
      <div className="flex h-8 items-center gap-2 pl-1">
        {href ? <Link href={href} className="flex min-w-0 items-center gap-2 hover:text-sol-cyan">{name}</Link> : <span className="flex min-w-0 items-center gap-2">{name}</span>}
        {group.items.length > 0 && (
          <span className="shrink-0 text-meta tabular-nums text-sol-text-dim">
            {group.items.length} {group.items.length === 1 ? "session" : "sessions"}
          </span>
        )}
      </div>
      {outcomes.length > 0 && (
        <div data-activity-outcomes className="mb-1 flex flex-wrap items-center gap-1.5 pl-8">
          {shownOutcomes}
          {shownOutcomes.length < outcomes.length && (
            <button type="button" onClick={() => setAllOutcomes(true)} className="h-5 rounded px-1.5 text-meta tabular-nums text-sol-text-muted hover:bg-sol-text/[0.06] hover:text-sol-text modern:rounded-control">
              +{outcomes.length - shownOutcomes.length}
            </button>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <ul>
          {rows.map((item) => (
            <ActivityRow key={item.id} item={item} relative={relative} showActor={by === "project"} teamId={teamId} />
          ))}
        </ul>
      )}
      {rows.length < group.items.length && (
        <button type="button" onClick={() => setAllRows(true)} className="ml-7 h-7 rounded-md px-2 text-meta text-sol-text-muted hover:bg-sol-text/[0.04] hover:text-sol-text modern:rounded-control">
          Show {group.items.length - rows.length} more
        </button>
      )}
    </div>
  );
}

/** The end of the list: older days from what is loaded first, then older
 *  pages from the server. Fires when it nears the bottom of the page's own
 *  scroller (one observer, no scroll listener) and on a press. */
export function ActivityLoadOlder({ onLoad, busy, shown, more }: {
  onLoad: () => void;
  busy: boolean;
  /** How much is on the page: a change re-arms the observer. */
  shown: number;
  /** Older work is known to exist; at the believed end only the observer stays, to re-check now and then. */
  more: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const load = useRef(onLoad);
  load.current = onLoad;
  // Observed afresh whenever the list grew or a load settled: a new observer
  // reports at once, so a list still shorter than the page keeps filling.
  useWatchEffect(() => {
    const el = ref.current;
    if (!el || busy || typeof IntersectionObserver === "undefined") return;
    const root = el.closest("[data-main-scroll]");
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) load.current(); }, { root, rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, busy]);
  return (
    <div ref={ref} data-activity-load-older className="flex h-12 items-center justify-center">
      {busy ? (
        <Spinner className="text-sol-text-dim" />
      ) : more ? (
        <button type="button" onClick={() => load.current()} className="h-7 rounded-md px-3 text-meta text-sol-text-muted hover:bg-sol-text/[0.04] hover:text-sol-text modern:rounded-control">
          Load older
        </button>
      ) : null}
    </div>
  );
}
