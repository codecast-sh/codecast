"use client";
// /expectations: every project's document of how its product should behave
// (the-line-model.md LM5), one row each. Documents waiting on someone lead,
// then the ones findings break most; each row says how big the document is,
// how often its lines broke lately and which line broke most, and opens the
// project's Expectations tab. Projects with no document yet follow, each a
// click from starting one.
import { useMemo } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useSyncProjects } from "../../hooks/useSyncProjects";
import { useExpectationsOverview, useSyncExpectationsOverview, type ExpectationsOverviewRow } from "../../hooks/useSyncExpectationsOverview";
import { shortDay } from "../../lib/line/runReport";
import { cn } from "../../lib/utils";
import { EXPECTATIONS_ABOUT, expectationsHref, sortOverview } from "../../lib/expectations/view";

const ref = (r: ExpectationsOverviewRow) => r.project.short_id || r.project.id;

export function ExpectationsOverview() {
  useSyncProjects();
  const { ready } = useSyncExpectationsOverview();
  const rows = useExpectationsOverview();
  const { documents, without } = useMemo(() => sortOverview(rows), [rows]);
  const totals = useMemo(() => documents.reduce((t, r) => ({ lines: t.lines + r.active, waiting: t.waiting + r.open_proposals, breaks7: t.breaks7 + r.breaks7 }), { lines: 0, waiting: 0, breaks7: 0 }), [documents]);

  return (
    <div className="h-full overflow-y-auto" data-expectations-overview>
      <div className="mx-auto max-w-[72rem] px-4 py-8 sm:px-6 space-y-8">
        <header>
          <h1 className="text-[18px] font-semibold text-sol-text">Expectations</h1>
          <p className="mt-1 max-w-[48rem] text-[13px] leading-relaxed text-sol-text-muted">{EXPECTATIONS_ABOUT} Each project keeps its own document; a proposal changes it, and every version is kept.</p>
          {documents.length > 0 && (
            <p className="mt-3 text-[12px] text-sol-text-dim tabular-nums" data-expectations-overview-totals>
              {documents.length} {documents.length === 1 ? "document" : "documents"}, {totals.lines} lines
              {totals.waiting > 0 && <span className="text-sol-yellow">, {totals.waiting} proposed {totals.waiting === 1 ? "change waits" : "changes wait"}</span>}
              {totals.breaks7 > 0 && <span className="text-sol-red">, {totals.breaks7} {totals.breaks7 === 1 ? "break" : "breaks"} this week</span>}
            </p>
          )}
        </header>

        {!ready && rows.length === 0 ? (
          <p className="text-[12.5px] text-sol-text-dim">Reading every project's expectations…</p>
        ) : (
          <>
            {documents.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-sol-border/30" data-expectations-documents>
                <div className="hidden grid-cols-[minmax(12rem,1.1fr)_6rem_10rem_minmax(14rem,1.6fr)] gap-x-4 border-b border-sol-border/30 bg-sol-bg-alt/40 px-4 py-1.5 text-[11px] text-sol-text-dim md:grid">
                  <span>Project</span>
                  <span className="text-right">Lines</span>
                  <span className="text-right">Breaks, 30 days</span>
                  <span>Broken most</span>
                </div>
                <ul className="divide-y divide-sol-border/20">
                  {documents.map((r) => <DocumentRow key={r._id} r={r} />)}
                </ul>
              </div>
            ) : (
              <p className="text-[13px] text-sol-text-muted" data-expectations-overview-empty>No project has expectations yet. Open a project below to start its document.</p>
            )}

            {without.length > 0 && (
              <section data-expectations-without>
                <h2 className="mb-2 text-[12.5px] font-semibold text-sol-text">No expectations yet</h2>
                <div className="flex flex-wrap gap-2">
                  {without.map((r) => (
                    <Link key={r._id} href={expectationsHref(ref(r))} className="group inline-flex items-center gap-1.5 rounded-md border border-sol-border/40 px-2.5 py-1 text-[12px] text-sol-text-muted hover:border-sol-blue/40 hover:text-sol-text" data-expectations-start={ref(r)}>
                      {r.project.title}
                      <span className="text-sol-text-dim group-hover:text-sol-blue">Start</span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DocumentRow({ r }: { r: ExpectationsOverviewRow }) {
  const quiet = r.active - r.broken;
  return (
    <li className="grid gap-x-4 gap-y-1 px-4 py-3 md:grid-cols-[minmax(12rem,1.1fr)_6rem_10rem_minmax(14rem,1.6fr)] hover:bg-sol-bg-alt/30" data-expectations-document={ref(r)}>
      <div className="min-w-0">
        <Link href={expectationsHref(ref(r))} className="group inline-flex items-center gap-1 text-[13px] font-medium text-sol-text hover:text-sol-blue">
          {r.project.title}<ArrowRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
        </Link>
        <div className="text-[11px] text-sol-text-dim tabular-nums">
          version {r.version}{r.applied_at ? `, ${shortDay(r.applied_at)}` : ""}
          {r.open_proposals > 0 && <Link href={expectationsHref(ref(r))} className="ml-1.5 text-sol-yellow hover:underline" data-expectations-waiting>{r.open_proposals} waiting</Link>}
        </div>
      </div>
      <div className="text-[12px] tabular-nums md:text-right">
        <span className="text-sol-text">{r.active}</span>
        <span className="text-sol-text-dim">{r.active ? ` in ${r.parts} ${r.parts === 1 ? "area" : "areas"}` : r.retired ? ", all retired" : ""}</span>
      </div>
      <div className="text-[12px] tabular-nums md:text-right" title={`${r.broken} of ${r.active} lines broken in 30 days; ${quiet} never cited`}>
        <span className={cn("font-semibold", r.breaks7 ? "text-sol-red" : r.breaks30 ? "text-sol-orange" : "text-sol-text-dim")}>{r.breaks30}</span>
        {r.breaks7 > 0 && <div className="text-[11px] text-sol-red/90">{r.breaks7} this week</div>}
        {r.active > 0 && <div className="text-[11px] text-sol-text-dim">{quiet} never cited</div>}
      </div>
      <div className="min-w-0 text-[12px]">
        {r.most_broken.length === 0 ? (
          <span className="text-sol-text-dim">No line broken in 30 days</span>
        ) : (
          <ul className="space-y-0.5">
            {r.most_broken.map((m) => (
              <li key={m.id} className="flex items-baseline gap-2">
                <span className="w-6 shrink-0 text-right tabular-nums text-sol-orange">{m.d30}</span>
                <Link href={expectationsHref(ref(r), m.id)} className="min-w-0 truncate text-sol-text-muted hover:text-sol-blue" title={`${m.text} (${m.id})`}>{m.text}</Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
