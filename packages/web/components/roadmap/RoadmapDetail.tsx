"use client";
// A roadmap row's sheet, beside the chart: where it stands against its
// target, its burn-up drawn large (the work there was, the work done, and
// where the last four weeks' pace lands), its milestones, the roles whose
// area holds it with their sessions, and its tasks in motion and just done.
// Every name opens its own page.
import { useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight, X } from "lucide-react";
import type { InitiativeUpdateRow } from "@codecast/shared/contracts/initiative";
import { objectHref } from "@codecast/shared/entities";
import { targetDayOf, targetDayStamp } from "@codecast/shared/time";
import { useInboxStore } from "../../store/inboxStore";
import { HEALTH_COLOR } from "../../lib/initiativeColors";
import { cn } from "../../lib/utils";
import { HealthChip, OwnerChip } from "../initiatives/InitiativeAtoms";
import { IntentTargetChip } from "../initiatives/IntentHeader";
import { RoleFace } from "../org/RoleFace";
import { ORG_STATE_ORDER, type OrgSession } from "../org/orgTypes";
import { DAY, standingOf, type Roadmap, type RoadRow, type RoadTask } from "./roadmapModel";
import { dayLabel, fmtDay, PACE_COLOR, rowAccent, STANDING_WORD } from "./roadmapAtoms";

const HAIR = "color-mix(in srgb, var(--sol-border) 30%, transparent)";
const DIM = "var(--sol-text-dim)";
const MUTED = "var(--sol-text-muted)";
const STATE_COLOR: Record<string, string> = { working: "var(--sol-green)", needs_input: "var(--sol-yellow)", dormant: "var(--sol-blue)", done: "var(--sol-text-dim)", idle: "var(--sol-text-dim)" };
const STATE_WORD: Record<string, string> = { working: "working", needs_input: "needs input", dormant: "dormant", done: "done", idle: "idle" };

type Index = Map<string, { tasks: RoadTask[] }>;

export function RoadmapDetail({ row: r, now, index, updates, map, onClose, onSelect, phone }: {
  phone?: boolean; row: RoadRow; now: number; index: Index; updates: InitiativeUpdateRow[]; map: Roadmap; onClose: () => void; onSelect: (key: string) => void;
}) {
  const accent = rowAccent(r);
  const s = standingOf(r, now);
  const href = r.kind === "goal" ? objectHref("initiative", r.ref) : r.kind === "project" ? objectHref("project", r.ref) : objectHref("role", r.ref);
  const tasks = useMemo(() => r.projectIds.flatMap((id) => index.get(id)?.tasks ?? []), [r.projectIds, index]);
  const moving = tasks.filter((t) => t.status === "in_progress" || t.status === "in_review").sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const closed = tasks.filter((t) => t.status === "done").sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0));
  const sessions = [...r.sessions].sort((a, b) => ORG_STATE_ORDER.indexOf(a.state) - ORG_STATE_ORDER.indexOf(b.state) || b.updated_at - a.updated_at);
  const children = r.children.map((k) => map.byKey.get(k)).filter((c): c is RoadRow => !!c);
  const left = r.target ? Math.round((r.target - now) / DAY) : null;
  const latest = updates.length ? updates.reduce((a, b) => (b.at > a.at ? b : a)) : null;

  return (
    <aside className={cn("flex shrink-0 flex-col border-l", phone ? "fixed inset-0 z-50 w-full" : "w-[440px]")} style={{ borderColor: HAIR, background: "var(--sol-bg)" }} data-roadmap-detail>
      <div className="flex items-start gap-2 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <div className="text-[11px]" style={{ color: DIM }}>{r.kind === "goal" ? "Goal" : r.kind === "project" ? "Project" : "Role"} · {r.ref}</div>
          <h2 className="mt-1 text-[19px] font-medium leading-[1.25]" style={{ fontFamily: "var(--font-serif)" }}>{r.title}</h2>
        </div>
        <Link href={href} className="grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-sol-bg-highlight" title="Open its page" aria-label="Open its page"><ArrowUpRight className="h-4 w-4" style={{ color: MUTED }} /></Link>
        <button type="button" onClick={onClose} className="grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-sol-bg-highlight" aria-label="Close"><X className="h-4 w-4" style={{ color: MUTED }} /></button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 text-[12.5px]">
        <div className="grid grid-cols-[84px_1fr] items-center gap-x-3 gap-y-2">
          {r.kind === "goal" && <><Label>Health</Label><span>{r.health && r.health !== "none" ? <HealthChip health={r.health} at={r.row?.health_at} now={now} lower /> : <span style={{ color: DIM }}>no update yet</span>}</span></>}
          {r.kind === "goal" && <><Label>Owner</Label><OwnerChip owner={r.owner} /></>}
          {r.kind === "project" && <><Label>Lead</Label>{r.lead ? <RoleLink role={r.lead} /> : <span style={{ color: DIM }}>no lead</span>}</>}
          <Label>Deadline</Label>
          <span className="flex items-center gap-2">
            {r.kind === "role" ? <span>{r.target ? fmtDay(r.target, true) : "none"}</span> : <Deadline r={r} />}
            {left !== null && !r.ended && <span className="tabular-nums" style={{ color: left < 0 ? "var(--sol-red)" : DIM }}>{left < 0 ? `${-left}d over` : `${left}d left`}</span>}
          </span>
          <Label>Pace</Label>
          <span className="tabular-nums" style={{ color: MUTED }}>
            <span style={{ color: PACE_COLOR[s] }}>{STANDING_WORD[s]}</span>
            {r.forecast && r.total > r.done ? <> · lands <span style={{ color: "var(--sol-text)" }}>{dayLabel(r.forecast)}</span></> : null}
          </span>
        </div>

        <Chart r={r} now={now} accent={accent} updates={updates} />

        <div className="mt-3 grid grid-cols-4 gap-2 tabular-nums">
          <Stat n={r.done} of={r.total} label="done" />
          <Stat n={r.total - r.done} label="open" />
          <Stat n={r.pace.closed} label="closed 4w" />
          <Stat n={r.pace.opened} label="opened 4w" />
        </div>

        {latest && (
          <Section title="Latest update" count={updates.length > 1 ? `of ${updates.length}` : undefined}>
            <div className="flex items-center gap-2 text-[11.5px]" style={{ color: DIM }}>
              <HealthChip health={latest.health} now={now} lower /><span>{dayLabel(latest.at)}</span>
            </div>
            <p className="mt-1.5 line-clamp-6 whitespace-pre-wrap leading-[1.5]" style={{ color: "var(--sol-text-secondary)" }}>{latest.body}</p>
          </Section>
        )}

        {r.milestones.length > 0 && (
          <Section title="Milestones" count={`${r.milestones.filter((m) => m.done_at).length}/${r.milestones.length}`}>
            {r.milestones.map((m) => (
              <div key={m.key} className="flex items-center gap-2 py-1">
                <span className="h-[8px] w-[8px] shrink-0 rotate-45 border" style={{ borderColor: accent, background: m.done_at ? accent : "transparent" }} />
                <span className={cn("min-w-0 flex-1 truncate", m.done_at && "line-through opacity-60")}>{m.title}</span>
                <span className="shrink-0 tabular-nums text-[11px]" style={{ color: !m.done_at && m.date && m.date < now ? "var(--sol-red)" : DIM }}>{m.done_at ? dayLabel(m.done_at) : m.date ? dayLabel(m.date) : ""}</span>
              </div>
            ))}
          </Section>
        )}

        {children.length > 0 && (
          <Section title={r.kind === "role" ? "Projects" : "Under it"} count={children.length}>
            {children.map((c) => {
              const cs = standingOf(c, now);
              return (
                <button key={c.key} type="button" onClick={() => onSelect(c.key)} className="-mx-1.5 flex w-[calc(100%+12px)] items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-sol-bg-highlight/60">
                  <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: rowAccent(c) }} />
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  <MiniBar done={c.done} total={c.total} color={rowAccent(c)} />
                  <span className="w-[86px] shrink-0 text-right text-[11px]" style={{ color: PACE_COLOR[cs] }}>{c.target ? fmtDay(c.target, c.targetLocal) : STANDING_WORD[cs]}</span>
                </button>
              );
            })}
          </Section>
        )}

        {r.roles.length > 0 && r.kind !== "role" && (
          <Section title="Roles" count={r.roles.length}>
            {r.roles.map((role) => {
              const live = role.sessions.filter((x) => x.state === "working" || x.state === "needs_input").length;
              return (
                <div key={role._id} className="flex items-center gap-2 py-1">
                  <RoleLink role={role} />
                  {role._id === r.lead?._id && <span className="text-[10.5px]" style={{ color: DIM }}>{r.kind === "goal" ? "owner" : "lead"}</span>}
                  <span className="ml-auto text-[11px] tabular-nums" style={{ color: live ? "var(--sol-green)" : DIM }}>{live ? `${live} live` : `${role.sessions.length} sessions`}</span>
                </div>
              );
            })}
          </Section>
        )}

        {sessions.length > 0 && (
          <Section title="Sessions" count={sessions.length}>
            {sessions.slice(0, 10).map((x) => <SessionLine key={x._id} s={x} now={now} />)}
          </Section>
        )}

        {moving.length > 0 && (
          <Section title="In progress" count={moving.length}>
            {moving.slice(0, 8).map((t) => <TaskLine key={t._id} t={t} right={t.status === "in_review" ? "review" : ""} />)}
          </Section>
        )}
        {closed.length > 0 && (
          <Section title="Recently done" count={closed.length}>
            {closed.slice(0, 6).map((t) => <TaskLine key={t._id} t={t} right={t.closed_at ? dayLabel(t.closed_at) : ""} done />)}
          </Section>
        )}
      </div>
    </aside>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[11.5px]" style={{ color: DIM }}>{children}</span>;
}

function Section({ title, count, children }: { title: string; count?: number | string; children: React.ReactNode }) {
  return (
    <section className="mt-5 border-t pt-3" style={{ borderColor: HAIR }}>
      <h3 className="mb-1.5 flex items-baseline gap-2 text-[12px] font-medium" style={{ color: MUTED }}>{title}{count !== undefined && <span className="tabular-nums font-normal" style={{ color: DIM }}>{count}</span>}</h3>
      {children}
    </section>
  );
}

function Stat({ n, of, label }: { n: number; of?: number; label: string }) {
  return (
    <div className="rounded-md px-2 py-1.5" style={{ background: "color-mix(in srgb, var(--sol-bg-alt) 70%, transparent)" }}>
      <div className="text-[15px] leading-none" style={{ color: "var(--sol-text)" }}>{n}{of !== undefined && <span className="text-[11px]" style={{ color: DIM }}>/{of}</span>}</div>
      <div className="mt-1 text-[10.5px]" style={{ color: DIM }}>{label}</div>
    </div>
  );
}

function MiniBar({ done, total, color }: { done: number; total: number; color: string }) {
  return (
    <span className="h-[4px] w-[56px] shrink-0 overflow-hidden rounded-full" style={{ background: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }} title={`${done} of ${total}`}>
      <span className="block h-full rounded-full" style={{ width: `${total ? (done / total) * 100 : 0}%`, background: color }} />
    </span>
  );
}

function RoleLink({ role }: { role: RoadRow["roles"][number] }) {
  return (
    <Link href={objectHref("role", role.short_id)} className="inline-flex min-w-0 items-center gap-1.5 hover:underline">
      <RoleFace role={role as never} size={16} />
      <span className="truncate">{role.name}</span>
    </Link>
  );
}

function SessionLine({ s, now }: { s: OrgSession; now: number }) {
  const age = Math.max(0, now - s.updated_at);
  const ago = age < 3_600_000 ? `${Math.max(1, Math.round(age / 60_000))}m` : age < DAY ? `${Math.round(age / 3_600_000)}h` : `${Math.round(age / DAY)}d`;
  return (
    <Link href={`/conversation/${s._id}`} className="-mx-1.5 flex items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-sol-bg-highlight/60">
      <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: STATE_COLOR[s.state] }} title={STATE_WORD[s.state]} />
      <span className="min-w-0 flex-1 truncate">{s.title || s.short_id}</span>
      <span className="shrink-0 text-[11px] tabular-nums" style={{ color: DIM }}>{ago}</span>
    </Link>
  );
}

function TaskLine({ t, right, done }: { t: RoadTask; right: string; done?: boolean }) {
  return (
    <Link href={`/tasks/${t.short_id ?? t._id}`} className="-mx-1.5 flex items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-sol-bg-highlight/60">
      <span className="w-[62px] shrink-0 text-[11px] tabular-nums" style={{ color: DIM }}>{t.short_id}</span>
      <span className={cn("min-w-0 flex-1 truncate", done && "opacity-70")}>{t.title}</span>
      <span className="shrink-0 text-[11px] tabular-nums" style={{ color: DIM }}>{right}</span>
    </Link>
  );
}

function Deadline({ r }: { r: RoadRow }) {
  const st = () => useInboxStore.getState();
  if (r.kind === "goal") {
    return (
      <IntentTargetChip day={targetDayOf(r.target)} label="Target date" emptyLabel="No deadline"
        onCommit={(day) => { const ts = targetDayStamp(day); if (ts) st().updateInitiative(r.id, { target_date: ts }); }}
        onClear={() => st().updateInitiative(r.id, { target_date: null })}>
        {r.target ? <span className="tabular-nums">{fmtDay(r.target, false)}</span> : null}
      </IntentTargetChip>
    );
  }
  const d = r.target ? new Date(r.target) : null;
  return (
    <IntentTargetChip day={d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : undefined} label="Project deadline" emptyLabel="No deadline" accent="var(--sol-cyan)"
      onCommit={(day) => { const [y, m, dd] = day.split("-").map(Number); st().updateProject(r.id, { target_date: new Date(y, m - 1, dd, 23, 59, 59).getTime() }); }}
      onClear={() => st().updateProject(r.id, { target_date: null })}>
      {r.target ? <span className="tabular-nums">{fmtDay(r.target, true)}</span> : null}
    </IntentTargetChip>
  );
}

// ---------------------------------------------------------------- the chart

const CW = 400, CH = 170, PAD = { l: 30, r: 10, t: 12, b: 22 };

/** Work there was (the scope line) and work done (the fill) over time, with
 *  today, the target, and the pace carried forward from today. */
function Chart({ r, now, accent, updates }: { r: RoadRow; now: number; accent: string; updates: InitiativeUpdateRow[] }) {
  const end = Math.max(now + 7 * DAY, r.target ?? 0, Math.min(r.forecast ?? 0, now + 365 * DAY));
  const t0 = r.start;
  const maxY = Math.max(1, ...r.series.map((s) => s.total));
  const X = (t: number) => PAD.l + ((t - t0) / (end - t0)) * (CW - PAD.l - PAD.r);
  const Y = (v: number) => PAD.t + (1 - v / maxY) * (CH - PAD.t - PAD.b);
  const path = (k: "done" | "total") => r.series.map((s, i) => `${i ? "L" : "M"}${X(s.t).toFixed(1)},${Y(s[k]).toFixed(1)}`).join("");
  const done = path("done");
  const last = r.series.at(-1)!;
  const fx = r.forecast && r.total > r.done ? Math.min(r.forecast, end) : null;
  const fy = fx && r.forecast ? last.done + ((last.total - last.done) * (fx - now)) / (r.forecast - now) : null;
  const ticks = [0, Math.round(maxY / 2), maxY];
  const months: number[] = [];
  for (const d = new Date(new Date(t0).getFullYear(), new Date(t0).getMonth() + 1, 1); d.getTime() < end; d.setMonth(d.getMonth() + 1)) months.push(d.getTime());
  const step = Math.max(1, Math.ceil(months.length / 6));
  if (r.total === 0) return <div className="mt-4 rounded-md px-3 py-6 text-center text-[12px]" style={{ background: "var(--sol-bg-alt)", color: DIM }}>No tasks on its boards yet</div>;
  return (
    <figure className="mt-4">
    <Legend accent={accent} pace={!!fx} />
    <svg viewBox={`0 0 ${CW} ${CH}`} className="mt-4 w-full" role="img" aria-label="Tasks done over time" data-roadmap-chart>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={CW - PAD.r} y1={Y(v)} y2={Y(v)} stroke="var(--sol-border)" strokeOpacity={0.18} />
          <text x={PAD.l - 6} y={Y(v) + 3} textAnchor="end" fontSize={9} fill="var(--sol-text-dim)">{v}</text>
        </g>
      ))}
      {months.filter((_, i) => i % step === 0).map((m) => (
        <text key={m} x={X(m)} y={CH - 6} textAnchor="middle" fontSize={9} fill="var(--sol-text-dim)">{new Date(m).toLocaleDateString(undefined, { month: "short" })}</text>
      ))}
      <path d={`${done}L${X(last.t).toFixed(1)},${Y(0)}L${X(t0).toFixed(1)},${Y(0)}Z`} fill={accent} fillOpacity={0.22} />
      <path d={done} fill="none" stroke={accent} strokeWidth={1.75} />
      <path d={path("total")} fill="none" stroke="var(--sol-text-muted)" strokeWidth={1.25} strokeDasharray="1 0" strokeOpacity={0.7} />
      {fx && fy !== null && <line x1={X(now)} y1={Y(last.done)} x2={X(fx)} y2={Y(fy)} stroke={accent} strokeWidth={1.5} strokeDasharray="4 3" />}
      {fx && r.forecast && r.forecast <= end && <circle cx={X(fx)} cy={Y(last.total)} r={3} fill="var(--sol-bg)" stroke={accent} strokeWidth={1.5} />}
      {r.target && (
        <g>
          <line x1={X(r.target)} x2={X(r.target)} y1={PAD.t - 4} y2={CH - PAD.b} stroke={r.target < now ? "var(--sol-red)" : "var(--sol-text-muted)"} strokeWidth={1.25} />
          <text x={X(r.target) - 3} y={PAD.t + 4} textAnchor="end" fontSize={9} fill={r.target < now ? "var(--sol-red)" : "var(--sol-text-muted)"}>deadline</text>
        </g>
      )}
      <line x1={X(now)} x2={X(now)} y1={PAD.t - 4} y2={CH - PAD.b} stroke="var(--sol-blue)" strokeOpacity={0.6} />
      {updates.map((u) => u.at >= t0 && <circle key={u._id} cx={X(u.at)} cy={CH - PAD.b} r={2.75} fill={HEALTH_COLOR[u.health]} stroke="var(--sol-bg)" strokeWidth={1} />)}
      {r.milestones.map((m) => {
        const t = m.done_at ?? m.date;
        return t && t >= t0 && t <= end ? <rect key={m.key} x={X(t) - 3.5} y={PAD.t - 7.5} width={7} height={7} transform={`rotate(45 ${X(t)} ${PAD.t - 4})`} fill={m.done_at ? accent : "var(--sol-bg)"} stroke={accent} /> : null;
      })}
    </svg>
    </figure>
  );
}

function Legend({ accent, pace }: { accent: string; pace: boolean }) {
  const item = "inline-flex items-center gap-1.5";
  return (
    <figcaption className="mb-1 flex flex-wrap gap-x-3.5 text-[10.5px]" style={{ color: DIM }}>
      <span className={item}><span className="h-px w-3" style={{ background: "var(--sol-text-muted)" }} />all tasks</span>
      <span className={item}><span className="h-2 w-3 rounded-[1px]" style={{ background: accent, opacity: 0.45 }} />done</span>
      {pace && <span className={item}><span className="w-3 border-t border-dashed" style={{ borderColor: accent }} />at this pace</span>}
      <span className={item}><span className="h-2.5 w-px" style={{ background: "var(--sol-blue)" }} />today</span>
    </figcaption>
  );
}
