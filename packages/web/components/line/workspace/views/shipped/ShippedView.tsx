"use client";
// Shipped (doc "Signals to shipped: one pipeline"): the fixes in production
// and how their watch went, as the flow map lists them (shippedFixes):
// regressed first, with when the problem came back and the finding that
// reopened it, then those under watch, then the verified. The header's
// numbers count this same list. A row opens its problem; Deploys is one press in.
import { memo, useMemo } from "react";
import { Rocket } from "lucide-react";
import { FLOW_MAP_DAYS, type FlowMapShipped } from "@codecast/shared/contracts/flowMap";
import { useFlowMapRow } from "../../../../../hooks/useFlowMap";
import type { LineViewProps } from "../types";
import "../signals/signals.css";
import "./shipped.css";

const DAY = 86_400_000;
const day = (at: number | null) => (at == null ? "" : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
const STATE_WORDS = { regressed: "regressed", watching: "no recurrence", verified: "verified" } as const;

export const ShippedView = memo(function ShippedView({ space, workspace: ws, href, select }: LineViewProps) {
  const map = useFlowMapRow(space);
  const rows = map?.shipped ?? [];
  const sourceLabel = useMemo(() => new Map((map?.sources ?? []).map((s) => [s.key, s.label])), [map?.sources]);
  const n = { regressed: 0, watching: 0, verified: 0 };
  for (const r of rows) n[r.state]++;
  const deploys = { view: "deploys" as const, deploy: null };
  return (
    <div className="sh" data-shipped={rows.length}>
      <header className="sh-bar">
        <span className="sg-counts">
          <span className="sg-count" data-tone={n.regressed ? "bad" : "ok"}><i aria-hidden /><b className="lw-num">{n.regressed}</b> regressed</span>
          <span className="sg-count" data-tone="live"><i aria-hidden /><b className="lw-num">{n.watching}</b> watching</span>
          <span className="sg-count" data-tone="ok"><i aria-hidden /><b className="lw-num">{n.verified}</b> verified</span>
          <span className="sg-dim">last {FLOW_MAP_DAYS} days</span>
        </span>
        <a className="lw-chip sh-deploys" href={href(deploys)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select(deploys); }} data-shipped-deploys><Rocket className="w-3.5 h-3.5" aria-hidden />Deploys</a>
      </header>
      {rows.length === 0 ? <div className="lw-empty"><b>Nothing shipped in {FLOW_MAP_DAYS} days</b></div> : (
        <table className="sg-table sh-table">
          <colgroup><col data-c="dot" /><col /><col data-c="d" /><col data-c="w" /><col data-c="s" /></colgroup>
          <thead><tr><th aria-label="State" /><th scope="col">Fix</th><th scope="col">Shipped</th><th scope="col">Watch</th><th scope="col">State</th></tr></thead>
          <tbody>{rows.map((r) => <Row key={r.taskId} r={r} now={ws.now} sourceLabel={sourceLabel} href={href} select={select} />)}</tbody>
        </table>
      )}
    </div>
  );
});

function Row({ r, now, sourceLabel, href, select }: { r: FlowMapShipped; now: number; sourceLabel: ReadonlyMap<string, string>; href: LineViewProps["href"]; select: LineViewProps["select"] }) {
  const to = { view: "problems" as const, case: r.ref ?? r.taskId, run: null };
  const left = r.until != null ? Math.max(0, Math.ceil((r.until - now) / DAY)) : null;
  return (
    <tr className="sg-row" data-opens="" data-state={r.state} onClick={(e) => { if ((e.target as Element).closest("a") || e.metaKey || e.ctrlKey) return; select(to); }} data-shipped-row={r.ref ?? r.taskId}>
      <td><i className="sh-dot" data-state={r.state} /></td>
      <th scope="row" className="sg-name">
        <a href={href(to)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select(to); }}>{r.title}</a>
        <small>{r.ref ?? ""}{r.reopenedBy ? <> · {sourceLabel.get(r.reopenedBy.source) ?? r.reopenedBy.source}: {r.reopenedBy.title}</> : null}</small>
      </th>
      <td className="sh-d lw-num">{day(r.shippedAt)}</td>
      <td className="sh-d lw-num">{r.state === "watching" ? <>until {day(r.until)}<small>{left} {left === 1 ? "day" : "days"} left</small></> : r.until != null ? <>ended {day(r.until)}</> : null}</td>
      <td className="sh-state" data-state={r.state}>{STATE_WORDS[r.state]}{r.reopenedAt ? <small>{day(r.reopenedAt)}</small> : null}</td>
    </tr>
  );
}
