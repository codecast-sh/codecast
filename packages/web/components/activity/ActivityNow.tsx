import Link from "next/link";
import { Activity } from "lucide-react";
import { EmptyState } from "../ui/empty-state";
import { SessionStatusMark } from "../inbox/SessionStatusMark";
import { Face } from "./ActivityParts";
import type { ActivitySummary, NowPerson } from "./activityModel";

// The top of the Activity page: who is working right now (one card per
// person, their faces and live count, and what each live session is doing),
// then the period in four numbers.

const LINES_PER_PERSON = 3;

export function ActivityNowStrip({ people, personHref }: { people: NowPerson[]; personHref: (id: string) => string }) {
  const live = people.reduce((n, p) => n + p.items.length, 0);
  return (
    <section data-activity-now aria-label="Working now" className="mb-5">
      <div className="mb-2 flex h-6 items-center gap-2">
        <span className="text-mark font-semibold uppercase tracking-wide text-sol-text-muted">Now</span>
        {live > 0 && <span className="text-meta tabular-nums text-sol-green">{live} live</span>}
      </div>
      {people.length === 0 ? (
        <EmptyState size="inline" icon={Activity} title="No one is working now" className="rounded-lg border border-sol-border/40 bg-sol-card modern:rounded-card modern:border-sol-border" />
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]">
          {people.map((p) => {
            const more = p.items.length - LINES_PER_PERSON;
            return (
              <li key={p.actor.id} data-now-person={p.actor.id} className="min-w-0 list-none rounded-lg border border-sol-border/40 bg-sol-card px-3 pb-1.5 pt-2 modern:rounded-card modern:border-sol-border">
                <Link href={personHref(p.actor.id)} title={`Only ${p.actor.name}'s work`} className="flex h-7 min-w-0 items-center gap-2 rounded-md hover:text-sol-cyan modern:rounded-control">
                  <Face actor={p.actor} size={22} />
                  <span className="min-w-0 truncate text-ui font-semibold text-sol-text">{p.actor.name}</span>
                  <span className="ml-auto shrink-0 text-meta tabular-nums text-sol-green">{p.items.length} live</span>
                </Link>
                <ul className="mt-0.5">
                  {p.items.slice(0, LINES_PER_PERSON).map((i) => (
                    <li key={i.id} className="list-none">
                      <Link
                        href={`/conversation/${i.id}`}
                        data-now-session={i.id}
                        title={i.line ? `${i.title} · ${i.line}` : i.title}
                        className="flex h-7 min-w-0 items-center gap-2 rounded-md px-0.5 text-ui hover:bg-sol-text/[0.04] modern:rounded-control"
                      >
                        <span className="flex w-[22px] shrink-0 justify-center"><SessionStatusMark status={i.status} /></span>
                        <span className="min-w-0 truncate text-sol-text">{i.line || i.title}</span>
                      </Link>
                    </li>
                  ))}
                  {more > 0 && (
                    <li className="list-none">
                      <Link href={personHref(p.actor.id)} className="flex h-6 items-center pl-[30px] text-meta text-sol-text-dim hover:text-sol-text">
                        {more} more live
                      </Link>
                    </li>
                  )}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const sinceWords = (at: number) => {
  const d = new Date(at);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "today";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
};

/** The loaded period in four numbers: sessions, people, PRs merged, tasks done. */
export function ActivitySummaryRow({ summary }: { summary: ActivitySummary }) {
  const stats: Array<{ key: string; n: number; label: string; tone: string }> = [
    { key: "sessions", n: summary.sessions, label: summary.sessions === 1 ? "session" : "sessions", tone: "text-sol-text" },
    { key: "people", n: summary.people, label: summary.people === 1 ? "person" : "people", tone: "text-sol-text" },
    { key: "prs", n: summary.prsMerged, label: summary.prsMerged === 1 ? "PR merged" : "PRs merged", tone: summary.prsMerged > 0 ? "text-sol-violet" : "text-sol-text" },
    { key: "tasks", n: summary.tasksDone, label: summary.tasksDone === 1 ? "task done" : "tasks done", tone: summary.tasksDone > 0 ? "text-sol-green" : "text-sol-text" },
  ];
  return (
    <div data-activity-summary className="mb-5 flex flex-wrap items-baseline gap-x-6 gap-y-1 border-y border-sol-border/40 py-2.5 modern:border-sol-border">
      {stats.map((s) => (
        <span key={s.key} data-stat={s.key} className="inline-flex items-baseline gap-1.5">
          <span className={`text-title font-semibold tabular-nums ${s.tone}`}>{s.n}</span>
          <span className="text-ui text-sol-text-muted">{s.label}</span>
        </span>
      ))}
      {summary.since != null && <span className="ml-auto text-meta text-sol-text-dim">since {sinceWords(summary.since)}</span>}
    </div>
  );
}
