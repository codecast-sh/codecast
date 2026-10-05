// A role's playbook on its Overview (docs/architecture/org-staffing.md S38):
// what the role has learned, read from the same sections of its brief that
// `cast brief` and the wake frame read (rolePlaybook.ts), so the page never
// shows a second copy. How the role wakes is read off its trigger, not its
// words. Pure: the brief's narrative and the routine in, markup out.
import { useMemo } from "react";
import { briefBudget, briefBudgetWords, threadOverdue, wakeWords, type MetricReading, type PlaybookEntry, type RolePlaybook as Playbook, type RoleWake } from "@codecast/shared/contracts/rolePlaybook";

const DIM = { color: "var(--sol-text-dim)" } as const;
const BODY = { color: "var(--sol-text-secondary)" } as const;
const RECENT_READINGS = 3;

/** A day as written (2026-10-04) in the short form a row has room for: Oct 4. */
function shortDay(day: string | null): string | null {
  if (!day) return null;
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(at) ? day : new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function Block({ title, count, section, children }: { title: string; count?: number; section: string; children: React.ReactNode }) {
  return (
    <div className="px-2.5" data-playbook={section}>
      <h4 className="mb-1 flex items-baseline gap-1.5 text-[12.5px] font-semibold text-sol-text">
        {title}
        {count !== undefined && <span className="text-[11px] font-normal tabular-nums" style={DIM}>{count}</span>}
      </h4>
      {children}
    </div>
  );
}

/** One entry: its sentence, a quieter second line when it has one, and what it is dated by on the right. */
function Row({ text, sub, meta, tone }: { text: string; sub?: string | null; meta?: React.ReactNode; tone?: string }) {
  return (
    <li className="flex items-baseline gap-3 border-l pl-2.5" style={{ borderColor: tone ?? "var(--sol-border)" }}>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-relaxed" style={BODY}>{text}</p>
        {sub && <p className="text-[12px] leading-relaxed" style={DIM}>{sub}</p>}
      </div>
      {meta && <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums" style={DIM}>{meta}</span>}
    </li>
  );
}

/** The readings as a line, oldest to newest, with the milestones marked. Drawn
 *  only when at least three readings carry a number. */
function Trend({ readings }: { readings: MetricReading[] }) {
  const points = readings.filter((r) => r.number !== null);
  if (points.length < 3) return null;
  const W = 132, H = 30, PAD = 3;
  const values = points.map((r) => r.number!);
  const min = Math.min(...values), span = Math.max(...values) - min || 1;
  const xy = points.map((r, i) => [PAD + (i * (W - 2 * PAD)) / (points.length - 1), H - PAD - ((r.number! - min) / span) * (H - 2 * PAD)] as const);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" role="img" aria-label={`${points.length} readings, from ${values[0]} to ${values.at(-1)}`} data-playbook-trend={points.length}>
      <polyline points={xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} fill="none" stroke="var(--sol-cyan)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((r, i) => r.milestone && <circle key={r.raw} cx={xy[i][0]} cy={xy[i][1]} r={2.6} fill="var(--sol-bg, var(--sol-card))" stroke="var(--sol-yellow)" strokeWidth={1.5} />)}
      <circle cx={xy.at(-1)![0]} cy={xy.at(-1)![1]} r={2.4} fill="var(--sol-cyan)" />
    </svg>
  );
}

function Metric({ metric }: { metric: NonNullable<Playbook["metric"]> }) {
  const latest = metric.readings.at(-1);
  // Under the latest: the milestones and the few readings before it, newest first in one list.
  const earlier = metric.readings.filter((r) => r !== latest);
  const recent = new Set(earlier.filter((r) => !r.milestone).slice(-RECENT_READINGS));
  const rows = earlier.filter((r) => r.milestone || recent.has(r)).reverse();
  return (
    <Block title="North metric" section="metric">
      {metric.name && <p className="text-[13px] leading-relaxed" style={BODY} data-playbook-metric-name>{metric.name}</p>}
      {latest && (
        <div className="mt-1.5 flex items-center gap-3">
          <Trend readings={metric.readings} />
          <p className="min-w-0 text-[13px] leading-snug text-sol-text" data-playbook-latest={latest.written_on ?? ""}>
            <span className="font-semibold">{latest.text}</span>
            {latest.written_on && <span className="ml-1.5 text-[11px] tabular-nums" style={DIM}>{shortDay(latest.written_on)}</span>}
          </p>
        </div>
      )}
      {rows.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {rows.map((r) => (
            <li key={r.raw} className="flex items-baseline gap-2 text-[12px]" style={r.milestone ? BODY : DIM} {...(r.milestone ? { "data-playbook-milestone": r.written_on ?? "" } : {})}>
              <span className="inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full" style={r.milestone ? { border: "1.5px solid var(--sol-yellow)" } : undefined} />
              <span className="w-12 shrink-0 tabular-nums" style={DIM}>{shortDay(r.written_on)}</span>
              <span className="min-w-0">{r.milestone ? r.text.replace(/\s*\(?\s*milestone:?\s*/i, " · ").replace(/\)\s*$/, "") : r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

const dated = (e: PlaybookEntry) => shortDay(e.written_on);

/** The playbook's sections, each only when the role has written it. */
export function RolePlaybook({ playbook, narrative, now }: { playbook: Playbook; narrative: string | null | undefined; now: number }) {
  const budget = useMemo(() => briefBudget(narrative), [narrative]);
  return (
    <div className="space-y-4" data-role-playbook>
      {playbook.metric && <Metric metric={playbook.metric} />}
      {playbook.rules.length > 0 && (
        <Block title="Rules it learned" count={playbook.rules.length} section="rules">
          <ul className="space-y-1.5">
            {playbook.rules.map((r) => <Row key={r.raw} text={r.text} sub={r.mistake ? `Learned from: ${r.mistake}` : null} meta={dated(r)} tone="var(--sol-cyan)" />)}
          </ul>
        </Block>
      )}
      {playbook.refuted.length > 0 && (
        <Block title="Refuted, not to chase again" count={playbook.refuted.length} section="refuted">
          <ul className="space-y-1.5">
            {playbook.refuted.map((r) => <Row key={r.raw} text={r.text} meta={dated(r)} />)}
          </ul>
        </Block>
      )}
      {playbook.decisions.length > 0 && (
        <Block title="Standing decisions" count={playbook.decisions.length} section="decisions">
          <ul className="space-y-1.5">
            {playbook.decisions.map((d) => <Row key={d.raw} text={d.text} meta={[d.who, dated(d)].filter(Boolean).join(" · ") || undefined} tone="var(--sol-violet)" />)}
          </ul>
        </Block>
      )}
      {playbook.threads.length > 0 && (
        <Block title="Open threads" count={playbook.threads.length} section="threads">
          <ul className="space-y-1.5">
            {playbook.threads.map((t) => {
              const overdue = threadOverdue(t, now);
              return (
                <Row key={t.raw} text={t.text} tone={overdue ? "var(--sol-yellow)" : undefined} meta={
                  <>
                    {t.written_on && <span>opened {shortDay(t.written_on)}</span>}
                    {t.due_on && <span className="ml-1.5" style={overdue ? { color: "var(--sol-yellow)" } : undefined} data-playbook-due={overdue ? "overdue" : "ahead"}>{overdue ? "was due" : "due"} {shortDay(t.due_on)}</span>}
                  </>
                } />
              );
            })}
          </ul>
        </Block>
      )}
      {budget.near && (
        <p className="px-2.5 text-[11px]" style={{ color: budget.over ? "var(--sol-yellow)" : "var(--sol-text-dim)" }} data-playbook-budget={budget.over ? "over" : "near"}>
          Its brief is {briefBudgetWords(budget)}{budget.over ? ": over its budget, so it condenses at its next check" : ""}.
        </p>
      )}
    </div>
  );
}

/** How the role's check runs and why it last changed, read off its trigger. */
export function RoleWakeLine({ wake, className }: { wake: RoleWake; className?: string }) {
  const [cadence, ...rest] = wakeWords({ ...wake, why: null }).split(" · ");
  const day = wake.tuned_at ? shortDay(new Date(wake.tuned_at).toISOString().slice(0, 10)) : null;
  return (
    <div className={className} data-role-wake={wake.every_ms ?? ""}>
      <p className="text-[13px] leading-relaxed" style={BODY}>
        Its check runs <span className="font-semibold text-sol-text">{cadence}</span>
        {rest.map((part) => <span key={part}> · {part}</span>)}
      </p>
      {wake.why && (
        <p className="text-[12px] leading-relaxed" style={DIM} data-role-wake-why>
          It set this itself{day ? ` on ${day}` : ""}: {wake.why}
        </p>
      )}
    </div>
  );
}
