"use client";
// The week's small charts, shared by the role card on the map's This week
// (OrgNodeCards.HealthRoleCard), the role sheet's This week and its levers
// (healthParts.RoleLevers). One colour
// per measure everywhere: work in, work closed, and a daily limit.
import { RoleFace } from "./RoleFace";
import type { RoleFlow } from "./orgFlow";

export const FLOW_TONE = { reached: "var(--sol-blue)", closed: "var(--sol-green)", asked: "var(--sol-violet)", limit: "var(--sol-orange)" } as const;

const weekday = (day: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${day}T00:00:00Z`).getUTCDay()];

/** The week as seven bars, today last; an optional dashed line at a limit,
 *  and an optional outline of what the week was (a what-if's before). */
export function DayBars({ values, days, tone, width, height, limit, ghost, max: fixedMax }: { values: number[]; days: string[]; tone: string; width: number; height: number; limit?: number; ghost?: number[]; max?: number }) {
  const max = fixedMax ?? Math.max(1, ...values, ...(ghost ?? []), limit ?? 0);
  const gap = 2;
  const bw = (width - gap * (values.length - 1)) / values.length;
  const y = (v: number) => height - (Math.min(v, max) / max) * height;
  return (
    <svg width={width} height={height} className="shrink-0 overflow-visible" role="img" aria-label={days.map((d, i) => `${d}: ${values[i]}`).join(", ")}>
      {values.map((v, i) => {
        const x = i * (bw + gap);
        const g = ghost?.[i];
        return (
          <g key={i}>
            <title>{`${weekday(days[i])} ${days[i].slice(5)}: ${v}`}</title>
            {g !== undefined && g > 0 && <rect x={x} y={y(g)} width={bw} height={height - y(g)} rx={1.5} fill="none" stroke={tone} strokeOpacity={0.45} strokeDasharray="2 2" />}
            <rect x={x} y={v > 0 ? y(v) : height - 1} width={bw} height={v > 0 ? height - y(v) : 1} rx={1.5} fill={tone} opacity={i === values.length - 1 ? 1 : 0.62} />
          </g>
        );
      })}
      {limit !== undefined && limit <= max && <line x1={-2} x2={width + 2} y1={y(limit)} y2={y(limit)} stroke={FLOW_TONE.limit} strokeWidth={1} strokeDasharray="3 2" />}
    </svg>
  );
}

/** Work in and work closed, day by day, as pairs of bars on one scale: a
 *  week where the blue towers over the green is a role that is busy and not
 *  finishing. */
export function InOutBars({ inn, out, days, width, height, limit }: { inn: number[]; out: number[]; days: string[]; width: number; height: number; limit?: number }) {
  const max = Math.max(1, ...inn, ...out, limit ?? 0);
  const slot = width / inn.length;
  const bw = Math.max(2, (slot - 2) / 2);
  const y = (v: number) => height - (v / max) * height;
  const bar = (v: number, x: number, tone: string, key: string) => (
    <rect key={key} x={x} y={v > 0 ? y(v) : height - 1} width={bw} height={v > 0 ? height - y(v) : 1} rx={1} fill={tone} />
  );
  return (
    <svg width={width} height={height} className="shrink-0 overflow-visible" role="img" aria-label={days.map((d, i) => `${d}: ${inn[i]} in, ${out[i]} closed`).join("; ")}>
      {inn.map((v, i) => (
        <g key={i} opacity={i === inn.length - 1 ? 1 : 0.75}>
          <title>{`${weekday(days[i])} ${days[i].slice(5)}: ${v} in, ${out[i]} closed`}</title>
          {bar(v, i * slot, FLOW_TONE.reached, "in")}
          {bar(out[i], i * slot + bw, FLOW_TONE.closed, "out")}
        </g>
      ))}
      {limit !== undefined && <line x1={-2} x2={width + 2} y1={y(limit)} y2={y(limit)} stroke={FLOW_TONE.limit} strokeWidth={1} strokeDasharray="3 2" />}
    </svg>
  );
}

/** What a role's week comes to, in the words a person acts on. Each says
 *  something is off, and only that: a role that is fine says nothing here. */
function weekSignals(f: RoleFlow): { key: string; text: string; tone: string }[] {
  const out: { key: string; text: string; tone: string }[] = [];
  if (f.daysAtCap > 0) out.push({ key: "limit", text: `at its limit ${f.daysAtCap} of 7 days`, tone: FLOW_TONE.limit });
  if (f.stalls > 0) out.push({ key: "stuck", text: `${f.stalls} stuck`, tone: "var(--sol-yellow)" });
  if (f.wakesTotal >= 20 && f.doneTotal * 20 < f.wakesTotal) out.push({ key: "closing", text: "little getting closed", tone: "var(--sol-magenta)" });
  return out;
}

/**
 * A role's week as one card: who it is, how much work reached it against how
 * much it closed (the two numbers that say whether an area keeps up), the
 * days as paired bars, and the few signals that need a person. The map's
 * health card and the phone's list both paint this.
 */
export function RoleWeekBody({ f, days, headless }: { f: RoleFlow; days: string[]; /** Leave out the face and name where the role is already named (its sheet). */ headless?: boolean }) {
  const signals = weekSignals(f);
  return (
    <div className="flex flex-col gap-2" data-role-week={f.role.handle}>
      {!headless && <div className="flex items-center gap-2 min-w-0">
        <RoleFace role={f.role} size={26} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[14px] leading-tight font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>{f.role.name}</span>
        <span className="shrink-0 text-[10.5px] font-semibold" style={{ color: f.color }}>{f.statusWord}</span>
      </div>}
      <div className="flex items-end gap-3">
        <span className="flex items-baseline gap-1.5 tabular-nums">
          <span className="text-[26px] leading-none font-semibold" style={{ color: FLOW_TONE.reached }}>{f.wakesTotal}</span>
          <span className="text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>in</span>
          <span className="text-[15px] leading-none mx-0.5" style={{ color: "var(--sol-text-dim)" }}>→</span>
          <span className="text-[26px] leading-none font-semibold" style={{ color: FLOW_TONE.closed }}>{f.doneTotal}</span>
          <span className="text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>closed</span>
        </span>
        <span className="ml-auto"><InOutBars inn={f.wakes} out={f.done} days={days} width={62} height={26} /></span>
      </div>
      <div className="flex flex-wrap gap-1 min-h-[18px]">
        {signals.length === 0 ? (
          <span className="text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>keeping up</span>
        ) : signals.slice(0, 3).map((s) => (
          <span key={s.key} className="inline-flex items-center h-[18px] px-1.5 rounded text-[10.5px] font-medium" style={{ background: `color-mix(in srgb, ${s.tone} 14%, transparent)`, color: s.tone }} data-week-signal={s.key}>{s.text}</span>
        ))}
      </div>
    </div>
  );
}
