// Priorities lab (throwaway prototype): the small pieces every row draws: the
// day strip, a session's pill with its live state, the other-sessions stack,
// the live session states read off the store.
import Link from "next/link";
import { useMemo } from "react";
import { entityRoute } from "@codecast/shared/entities";
import { HEAT_COLORS, heatColor } from "../../ActivityHeatmap";
import { HoverCard } from "../../ui/HoverCard";
import { SessionStatusMark } from "../../inbox/SessionStatusMark";
import { SESSION_STATUS, sessionStatusOf, type SessionStatus } from "../../../lib/sessionStatus";
import { railRowPlacement, useInboxStore } from "../../../store/inboxStore";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { cn } from "../../../lib/utils";
import { ago, type ConnectedRaw, type SessionView } from "./labModel";

/** The right-hand column every row shares, so the days line up down the page. */
export const STRIP_W = 220;
export const LAB_GRID = "grid grid-cols-[minmax(0,1fr)_24px] items-center gap-x-4 [@container(min-width:44rem)]:grid-cols-[minmax(0,1fr)_220px_24px]";
export const STRIP_CELL = "hidden [@container(min-width:44rem)]:block";

/** Today's cell, in every strip and the band: one column reads down the page. (Inline: tailwind-merge drops a bare `outline`.) */
export const TODAY_OUTLINE = { outline: "1px solid color-mix(in srgb, var(--sol-text-muted) 75%, transparent)", outlineOffset: 1 } as const;

export function LabStrip({ counts, todayIndex, levels, landed, size }: {
  counts: number[];
  todayIndex: number;
  levels: number[];
  /** Days a milestone landed: a dot above the cell. */
  landed?: boolean[];
  size: "head" | "line";
}) {
  return (
    <span className="grid gap-[4px]" style={{ gridTemplateColumns: `repeat(${counts.length}, minmax(0, 1fr))` }}>
      {counts.map((c, i) => (
        <span key={i} className="flex flex-col items-center gap-[3px]">
          {landed && <i className={cn("block size-[4px] rounded-full", landed[i] ? "bg-sol-green" : "bg-transparent")} />}
          <i
            title={`${c} typed${landed?.[i] ? " · milestone landed" : ""}`}
            className={cn(
              "block w-full rounded-[2px]",
              size === "head" ? "h-[6px]" : "h-[4px]",
            )}
            style={{ background: heatColor(c, levels, HEAT_COLORS), ...(i === todayIndex ? TODAY_OUTLINE : null) }}
          />
        </span>
      ))}
    </span>
  );
}

/** Live state for each session short id (a 7-character prefix of the conversation id), from the inbox's own rows. */
export function useSessionStates(ids: string[]): Map<string, { status: SessionStatus; title: string; updated_at: number; convId: string }> {
  const now = useCoarseNow(30_000);
  const key = ids.join(",");
  const sig = useInboxStore((s) => {
    const index = prefixIndex(s.sessions as Record<string, any>);
    return key.split(",").filter(Boolean).map((id) => {
      const row = index.get(id.slice(0, 7).toLowerCase());
      if (!row) return "";
      const status = sessionStatusOf({ row, placement: railRowPlacement(row, now), now });
      return [id, status, row.updated_at ?? 0, row._id, (row.title ?? "").replace(/[\u0001\u0002]/g, "")].join("\u0001");
    }).filter(Boolean).join("\u0002");
  });
  return useMemo(() => {
    const out = new Map<string, { status: SessionStatus; title: string; updated_at: number; convId: string }>();
    for (const part of sig.split("\u0002").filter(Boolean)) {
      const [id, status, upd, convId, title] = part.split("\u0001");
      out.set(id, { status: status as SessionStatus, updated_at: Number(upd), convId, title });
    }
    return out;
  }, [sig]);
}

const prefixIndexes = new WeakMap<object, Map<string, any>>();
function prefixIndex(coll: Record<string, any> | undefined): Map<string, any> {
  if (!coll) return new Map();
  let idx = prefixIndexes.get(coll);
  if (!idx) {
    idx = new Map();
    for (const id in coll) idx.set(id.slice(0, 7).toLowerCase(), coll[id]);
    prefixIndexes.set(coll, idx);
  }
  return idx;
}

export function sessionView(raw: ConnectedRaw, live: ReturnType<typeof useSessionStates>): SessionView {
  const l = live.get(raw.short_id);
  return {
    short_id: raw.short_id,
    why: raw.why,
    title: raw.title || l?.title || "Title not on this device",
    status: l?.status ?? null,
    updated_at: Math.max(raw.updated_at, l?.updated_at ?? 0),
    href: l ? `/conversation/${l.convId}` : entityRoute("session", raw.short_id) ?? "#",
  };
}

const UNKNOWN = "State not on this device";

export function SessionPill({ s, className }: { s: SessionView; className?: string }) {
  return (
    <Link
      href={s.href}
      onClick={(e) => e.stopPropagation()}
      title={`${s.title} · ${s.status ? SESSION_STATUS[s.status].word : UNKNOWN}`}
      className={cn(
        "inline-flex h-6 min-w-0 max-w-[18rem] shrink items-center gap-1.5 rounded-control border border-sol-border/70 bg-sol-bg-alt/60 px-1.5 text-meta text-sol-text hover:border-sol-border hover:bg-sol-bg-alt",
        className,
      )}
    >
      {s.status ? <SessionStatusMark status={s.status} size={9} /> : <span className="size-[9px] shrink-0 rounded-full border border-dashed border-sol-text-dim/70" />}
      <span className="shrink-0 font-mono text-sol-text-dim">{s.short_id}</span>
      <span className="min-w-0 truncate">{s.title}</span>
    </Link>
  );
}

/** Why each session is connected: mapped by the pass, linked by a ref, bound to a task or to the plan. */
export function WhyTags({ why, className }: { why: string[]; className?: string }) {
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {why.map((w) => (
        <span key={w} className="rounded-[4px] bg-sol-text/[0.06] px-1 text-[10px] leading-4 text-sol-text-muted">{w}</span>
      ))}
    </span>
  );
}

/** The milestone's other sessions: up to four state dots and a count, the list on hover; sessions reached only through its plan are listed there, not counted. */
export function OtherSessions({ others, viaPlan, plan, now }: { others: SessionView[]; viaPlan: SessionView[]; plan?: string; now: number }) {
  if (others.length === 0 && viaPlan.length === 0) return null;
  const item = (s: SessionView) => (
    <li key={s.short_id}>
      <Link href={s.href} className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-2 px-3 py-1 text-ui hover:bg-sol-bg-alt">
        <span className="pt-[5px]">{s.status ? <SessionStatusMark status={s.status} size={9} /> : <span className="block size-[9px] rounded-full border border-dashed border-sol-text-dim/70" />}</span>
        <span className="min-w-0">
          <span className="block truncate text-sol-text">{s.title}</span>
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-sol-text-dim">
            <span>
              <span className={s.status ? SESSION_STATUS[s.status].text : undefined}>{s.status ? SESSION_STATUS[s.status].word : "State unknown"}</span>
              {s.updated_at ? ` · ${ago(s.updated_at, now)}` : ""}
            </span>
            <WhyTags why={s.why} />
          </span>
        </span>
        <span className="pt-px font-mono text-meta text-sol-text-dim">{s.short_id}</span>
      </Link>
    </li>
  );
  const head = "px-3 pb-1 pt-1.5 text-mark font-semibold uppercase tracking-wide text-sol-text-dim";
  const card = (
    <div className="max-h-80 overflow-y-auto py-1">
      {others.length > 0 && (
        <>
          <div className={head}>{others.length} more {others.length === 1 ? "session" : "sessions"}</div>
          <ul>{others.map(item)}</ul>
        </>
      )}
      {viaPlan.length > 0 && (
        <>
          <div className={cn(head, others.length > 0 && "mt-1 border-t border-sol-border/60 pt-2")}>{viaPlan.length} on plan {plan}</div>
          <ul>{viaPlan.map(item)}</ul>
        </>
      )}
    </div>
  );
  const label = others.length > 0 ? `${others.length} more sessions` : `${viaPlan.length} sessions on the plan`;
  return (
    <HoverCard card={card} side="bottom" className="w-[22rem]" triggerClassName="inline-flex shrink-0 items-center" focusable>
      <span data-lab-others role="button" tabIndex={0} aria-label={label} className="inline-flex h-6 cursor-default items-center gap-1 rounded-control px-1 text-meta tabular-nums text-sol-text-dim hover:bg-sol-bg-alt" onClick={(e) => e.stopPropagation()}>
        {others.length > 0 ? (
          <>
            <span className="inline-flex items-center -space-x-[2px]">
              {others.slice(0, 4).map((s) =>
                s.status
                  ? <span key={s.short_id} className="rounded-full bg-sol-bg"><SessionStatusMark status={s.status} size={8} /></span>
                  : <span key={s.short_id} className="size-[8px] rounded-full border border-dashed border-sol-text-dim/70 bg-sol-bg" />,
              )}
            </span>
            +{others.length}
          </>
        ) : (
          <span title={`${viaPlan.length} sessions on the plan`} className="text-sol-text-dim/80">{viaPlan.length} on plan</span>
        )}
      </span>
    </HoverCard>
  );
}
