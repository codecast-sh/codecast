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
import { ago, type SessionView } from "./labModel";

/** The right-hand column every row shares, so the days line up down the page. */
export const STRIP_W = 220;
export const LAB_GRID = "grid grid-cols-[minmax(0,1fr)_24px] items-center gap-x-4 [@container(min-width:44rem)]:grid-cols-[minmax(0,1fr)_220px_24px]";
export const STRIP_CELL = "hidden [@container(min-width:44rem)]:block";

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
              i === todayIndex && "outline outline-1 outline-offset-1 outline-sol-text-dim/70",
            )}
            style={{ background: heatColor(c, levels, HEAT_COLORS) }}
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

export function sessionView(raw: { short_id: string; title: string; updated_at: number }, live: ReturnType<typeof useSessionStates>): SessionView {
  const l = live.get(raw.short_id);
  return {
    short_id: raw.short_id,
    title: raw.title || l?.title || "Untitled session",
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

/** The milestone's other sessions: up to four state dots and a count, the list on hover. */
export function OtherSessions({ others, now }: { others: SessionView[]; now: number }) {
  if (others.length === 0) return null;
  const card = (
    <div className="py-1.5">
      <div className="px-3 pb-1 text-mark font-semibold uppercase tracking-wide text-sol-text-dim">{others.length} more sessions</div>
      <ul className="max-h-72 overflow-y-auto">
        {others.map((s) => (
          <li key={s.short_id}>
            <Link href={s.href} className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1 text-ui hover:bg-sol-bg-alt">
              {s.status ? <SessionStatusMark status={s.status} size={9} /> : <span className="size-[9px] rounded-full border border-dashed border-sol-text-dim/70" />}
              <span className="min-w-0">
                <span className="block truncate text-sol-text">{s.title}</span>
                <span className="block text-meta text-sol-text-dim">
                  <span className={s.status ? SESSION_STATUS[s.status].text : undefined}>{s.status ? SESSION_STATUS[s.status].word : "State unknown"}</span>
                  {s.updated_at ? ` · ${ago(s.updated_at, now)}` : ""}
                </span>
              </span>
              <span className="font-mono text-meta text-sol-text-dim">{s.short_id}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <HoverCard card={card} side="bottom" className="w-80" triggerClassName="inline-flex shrink-0 items-center">
      <span data-lab-others className="inline-flex h-6 cursor-default items-center gap-1 rounded-control px-1 text-meta tabular-nums text-sol-text-dim hover:bg-sol-bg-alt" onClick={(e) => e.stopPropagation()}>
        <span className="inline-flex items-center -space-x-[2px]">
          {others.slice(0, 4).map((s) =>
            s.status
              ? <span key={s.short_id} className="rounded-full bg-sol-bg"><SessionStatusMark status={s.status} size={8} /></span>
              : <span key={s.short_id} className="size-[8px] rounded-full border border-dashed border-sol-text-dim/70 bg-sol-bg" />,
          )}
        </span>
        +{others.length}
      </span>
    </HoverCard>
  );
}
