"use client";
// Every device's checkouts of the repository, under its pipeline (ct-98780):
// which machines hold work main does not have, whose it is, and what is stuck.
// A finished session's uncommitted work offers Ship, which asks that session to
// run its change through the repo's change flow (the same message and confirm
// RunThroughFlow sends from a session's header).
import { memo, useMemo, useState } from "react";
import Link from "next/link";
import { useCheckouts, useSyncCheckouts } from "../../../hooks/useSyncCheckouts";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useInboxStore } from "../../../store/inboxStore";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { shipLedgerFor } from "../../consequential/shipLedger";
import { runThroughMessage } from "../../../lib/line/flowMessages";
import { agoWords, drawnFlow } from "../../../lib/line/pipelineModel";
import { checkoutsByMachine, checkoutsSummary, type CheckoutSessionView, type CheckoutView } from "../../../lib/line/checkoutsModel";
import type { Pipeline } from "../../../lib/line/pipelineTypes";

const STATE_WORDS = { working: "working", idle: "idle", finished: "finished" } as const;

type TitleRow = { title?: string | null };

export const CheckoutsSection = memo(function CheckoutsSection({ pipeline, teamId }: { pipeline: Pipeline; teamId: string | null }) {
  const { ready, error, refused } = useSyncCheckouts(teamId);
  const rows = useCheckouts(teamId, pipeline.repository);
  const now = useCoarseNow(60_000);
  // Sessions by their titles in this viewer's store: a team row never carries a private session's title.
  const ids = useMemo(() => [...new Set(rows.flatMap((r) => [...r.uncommitted.sessions.map((s) => s.conversation_id), r.level.state === "stuck" && r.level.filed?.to === "session" ? r.level.filed.conversation_id : null]).filter((x): x is string => !!x))].sort().join(","), [rows]);
  const titleSig = useInboxStore((s) => JSON.stringify(Object.fromEntries((ids ? ids.split(",") : []).map((id) => {
    const row = ((s.sessions as Record<string, TitleRow>)[id] ?? (s.conversations as Record<string, TitleRow>)[id]) as TitleRow | undefined;
    return [id, row?.title ?? null];
  }))));
  const machines = useMemo(() => {
    const titles = JSON.parse(titleSig) as Record<string, string | null>;
    return checkoutsByMachine(rows, now, (id) => titles[id]);
  }, [rows, now, titleSig]);
  const summary = useMemo(() => checkoutsSummary(rows), [rows]);
  const flow = useMemo(() => drawnFlow(pipeline.change), [pipeline.change]);
  const [shipping, setShipping] = useState<CheckoutSessionView | null>(null);

  const ship = (s: CheckoutSessionView) => {
    if (!s.conversationId) return;
    useInboxStore.getState().sendMessage(s.conversationId, runThroughMessage(flow));
    setShipping(null);
  };

  return (
    <section className="rpl-checkouts" id="checkouts" aria-label="Checkouts" data-pipeline-checkouts>
      <header className="rpl-lane-head">
        <span className="rpl-lane-title">Checkouts</span>
        {rows.length ? (
          <span className="rpl-figs">
            <span className="rpl-fig" data-on=""><b className="lw-num">{summary.machines}</b> {summary.machines === 1 ? "machine" : "machines"}</span>
            <span className="rpl-fig" data-on={summary.holdingWork ? "" : undefined}><b className="lw-num">{summary.holdingWork}</b> hold work main doesn't have</span>
            {summary.stuck ? <span className="rpl-fig" data-tone="bad"><b className="lw-num">{summary.stuck}</b> stuck</span> : null}
          </span>
        ) : null}
      </header>
      {!rows.length ? (
        <div className="rpl-checkouts-empty">
          {!ready ? "Reading checkouts…" : refused ? "Checkouts are not shared in this workspace" : error ? "Checkouts could not be read" : "No machine reports its checkouts of this repository yet"}
        </div>
      ) : (
        <div className="rpl-machines">
          {machines.map((m) => (
            <div key={m.device} className="rpl-machine">
              <div className="rpl-machine-name">{m.machine}</div>
              {m.checkouts.map((c) => <CheckoutCard key={c.id} c={c} now={now} onShip={setShipping} />)}
            </div>
          ))}
        </div>
      )}
      {shipping ? <SwitchReview ledger={shipLedgerFor(flow, shipping.title)} onClose={() => setShipping(null)} onConfirm={() => ship(shipping)} /> : null}
    </section>
  );
});

function CheckoutCard({ c, now, onShip }: { c: CheckoutView; now: number; onShip: (s: CheckoutSessionView) => void }) {
  return (
    <div className="rpl-checkout" data-tone={c.level.tone} data-holds={c.holdsWork ? "" : undefined}>
      <div className="rpl-checkout-head">
        <span className="rpl-checkout-folder" title={c.path}>{c.folder}</span>
        {c.branch && c.branch !== "main" ? <span className="rpl-checkout-fact">{c.branch}</span> : null}
        {c.ahead ? <span className="rpl-checkout-fact" data-tone="warn"><b className="lw-num">{c.ahead}</b> commits main doesn't have</span> : null}
        {c.behind ? <span className="rpl-checkout-fact"><b className="lw-num">{c.behind}</b> behind main</span> : null}
        {c.total ? <span className="rpl-checkout-fact" data-tone="warn"><b className="lw-num">{c.total}</b> uncommitted {c.total === 1 ? "file" : "files"}</span> : null}
        <span className="rpl-checkout-level" data-tone={c.level.tone} title={c.level.files.join("\n") || undefined}>{c.level.words}</span>
        {c.level.told ? <span className="rpl-checkout-fact" data-tone={c.level.told === "nobody told yet" ? "bad" : undefined}>{c.level.told}</span> : null}
      </div>
      {c.sessions.length || c.unattributed.paths.length ? (
        <ul className="rpl-work">
          {c.sessions.map((s) => (
            <li key={s.key} className="rpl-work-row" data-state={s.state}>
              <span className="rpl-work-state">{STATE_WORDS[s.state]}</span>
              {s.conversationId ? <Link href={`/conversation/${s.conversationId}`} className="rpl-work-title">{s.title}</Link> : <span className="rpl-work-title">{s.title}</span>}
              <Files paths={s.paths} more={s.more} />
              <span className="rpl-work-at">{agoWords(s.lastActivity, now)}</span>
              {s.canShip ? <button type="button" className="rpl-lane-editbtn" onClick={() => onShip(s)} data-checkout-ship>Ship</button> : <span />}
            </li>
          ))}
          {c.unattributed.paths.length ? (
            <li className="rpl-work-row" data-state="none">
              <span className="rpl-work-state">no session</span>
              <span className="rpl-work-title">edits no session wrote</span>
              <Files paths={c.unattributed.paths} more={c.unattributed.more} />
              <span />
              <span />
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** A group's files: how many, opening to the paths. */
function Files({ paths, more }: { paths: string[]; more: number }) {
  const n = paths.length + more;
  return (
    <details className="rpl-work-files">
      <summary><b className="lw-num">{n}</b> {n === 1 ? "file" : "files"}</summary>
      <ul>{paths.map((p) => <li key={p}>{p}</li>)}{more ? <li className="rpl-work-more">+{more} more</li> : null}</ul>
    </details>
  );
}
