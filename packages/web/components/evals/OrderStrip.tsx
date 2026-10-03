// The recorded delivery order as chips (docs/architecture/evals-ui.md 4.7).
// After a shrink the removed chips fade to a quarter, and the caption says how
// many deliveries the failure needs. A chip moves the playhead to its delivery.

import type { CSSProperties } from "react";
import type { SimMinimal } from "@codecast/shared/contracts/evalsApi";
import { feedTone, parseChannel, shrinkCaption } from "./simLanes";
import "./sim.css";

export interface OrderStripProps {
  channels: readonly string[];
  /** A scripted run's order leads with the scripted mark (not a delivery). */
  scripted: boolean;
  minimal: SimMinimal | null;
  failAt: number | null;
  playhead: number | null;
  onPick: (i: number) => void;
  feeds: readonly string[];
}

/** A channel in a few characters: `conn laptop-host`, `live laptop-host/inbox`, `repl a > b`. */
export function chipText(channel: string): string {
  const p = parseChannel(channel);
  switch (p.kind) {
    case "conn":
      return `conn ${p.window}`;
    case "live":
      return `live ${p.window}/${p.feed}`;
    case "repl":
      return `repl ${p.from} > ${p.to}`;
    case "bridge":
      return `bridge ${p.device}${p.from ? `/${p.from}` : ""}`;
    case "timer":
      return `timer ${p.owner}`;
    case "sched":
      return "sched";
    case "actor":
      return `actor ${p.name}`;
    default:
      return p.raw;
  }
}

function chipTone(channel: string, feeds: readonly string[]): string {
  const p = parseChannel(channel);
  if (p.kind === "live") return feedTone(feeds, p.feed);
  if (p.kind === "actor" || p.kind === "repl") return "var(--sol-text)";
  return "var(--sol-text-dim)";
}

export function OrderStrip({ channels, scripted, minimal, failAt, playhead, onPick, feeds }: OrderStripProps) {
  const removed = new Set(minimal?.removed ?? []);
  return (
    <section className="evs-order" data-evs-order={channels.length} data-evs-shrunk={minimal ? "yes" : "no"}>
      <div className="evs-section-title" style={{ margin: 0 }}>
        Delivery order
        <span className="evs-note" data-evs-caption>
          {shrinkCaption(channels.length, minimal)}
          {scripted ? ", a scripted run (the order leads with the scripted mark)" : ""}
          {minimal ? `, ${minimal.attempts} attempts in ${Math.round(minimal.ms / 1000)} s` : ""}
        </span>
      </div>
      <div className="evs-order-chips">
        {channels.map((c, i) => (
          <button
            key={i}
            type="button"
            className="evs-ochip"
            data-evs-removed={removed.has(i) || undefined}
            data-evs-at={playhead === i || undefined}
            data-evs-fail={failAt === i || undefined}
            title={`#${i + 1} ${c}${removed.has(i) ? ", removed by the shrink" : minimal ? ", needed" : ""}`}
            onClick={() => onPick(i)}
          >
            <span className="evs-ochip-n">{i + 1}</span>
            <span className="evs-ochip-dot" style={{ background: chipTone(c, feeds) } as CSSProperties} />
            {chipText(c)}
          </button>
        ))}
      </div>
    </section>
  );
}
