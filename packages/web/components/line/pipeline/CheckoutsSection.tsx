"use client";
// Every device's checkouts of the repository, under its pipeline (ct-98780).
// What needs a person leads: a stuck checkout (why, in a glance) and finished
// work nobody shipped, one action each. Then each machine's live checkouts as
// one row apiece, and its old worktrees (left alone by the sweep, nothing live
// in them) folded into one line. A row opens the checkout in the page's drawer:
// git's whole reason, the files, each session's work with its own Ship. Ship
// asks the session to run its change through the repo's change flow (the same
// message and confirm RunThroughFlow sends from a session's header).
import { memo, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useCheckouts, useSyncCheckouts } from "../../../hooks/useSyncCheckouts";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useInboxStore } from "../../../store/inboxStore";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { shipLedgerFor } from "../../consequential/shipLedger";
import { runThroughMessage } from "../../../lib/line/flowMessages";
import { agoWords, drawnFlow } from "../../../lib/line/pipelineModel";
import { checkoutsPage, checkoutsSummary, type CheckoutSessionView, type CheckoutView } from "../../../lib/line/checkoutsModel";
import type { Pipeline } from "../../../lib/line/pipelineTypes";
import { PipelineDrawer } from "./PipelineDrawer";

type TitleRow = { title?: string | null };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A checkout's light: stuck, work to ship, someone working in it, level, or left alone. */
const ledOf = (c: CheckoutView) => (c.level.tone === "stuck" ? "stuck" : c.finished.length ? "waiting" : c.sessions.some((s) => s.state === "working") ? "going" : c.level.tone === "ok" ? "current" : "off");

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
  const page = useMemo(() => {
    const titles = JSON.parse(titleSig) as Record<string, string | null>;
    return checkoutsPage(rows, now, (id) => titles[id]);
  }, [rows, now, titleSig]);
  const summary = useMemo(() => checkoutsSummary(rows), [rows]);
  const flow = useMemo(() => drawnFlow(pipeline.change), [pipeline.change]);
  const [shipping, setShipping] = useState<{ label: string; sessions: CheckoutSessionView[] } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? [...page.needs, ...page.machines.flatMap((m) => [...m.live, ...m.stale.checkouts])].find((c) => c.id === openId) ?? null : null;

  const shipAll = (c: CheckoutView) => setShipping({ label: c.finished.length === 1 ? c.finished[0].title : `${plural(c.finished.length, "finished session")} in ${c.folder}`, sessions: c.finished });
  const ship = () => {
    for (const s of shipping?.sessions ?? []) if (s.conversationId) useInboxStore.getState().sendMessage(s.conversationId, runThroughMessage(flow));
    setShipping(null);
  };

  return (
    <section className="ck" id="checkouts" aria-label="Checkouts" data-pipeline-checkouts>
      <header className="ck-head">
        <h3 className="ck-title">Checkouts</h3>
        {rows.length ? (
          <span className="ck-figs">
            <span><b>{summary.machines}</b> {summary.machines === 1 ? "machine" : "machines"}</span>
            <span><b>{summary.holdingWork}</b> holding work</span>
            {summary.stuck ? <span data-tone="bad"><b>{summary.stuck}</b> stuck</span> : null}
          </span>
        ) : null}
      </header>
      {!rows.length ? (
        <div className="ck-empty">
          {!ready ? "Reading checkouts…" : refused ? "Checkouts are not shared in this workspace" : error ? "Checkouts could not be read" : "No machine reports its checkouts of this repository yet"}
        </div>
      ) : (
        <>
          {page.needs.length ? (
            <div className="ck-group" data-group="needs">
              <div className="ck-group-name">Needs you</div>
              <ul className="ck-rows">
                {page.needs.map((c) => (
                  <Row key={c.id} c={c} machine onOpen={setOpenId} now={now}>
                    {c.finished.length
                      ? <button type="button" className="pv-btn" onClick={() => shipAll(c)} data-checkout-ship>Ship {c.finished.length === 1 ? "1 finished session's" : `${c.finished.length} finished sessions'`} work</button>
                      : <button type="button" className="pv-btn" onClick={() => setOpenId(c.id)}>See why</button>}
                  </Row>
                ))}
              </ul>
            </div>
          ) : null}
          {page.machines.map((m) => (
            <div key={m.device} className="ck-group">
              <div className="ck-group-name">{m.machine}</div>
              {m.live.length ? <ul className="ck-rows">{m.live.map((c) => <Row key={c.id} c={c} onOpen={setOpenId} now={now} />)}</ul> : null}
              {m.stale.checkouts.length ? (
                <details className="ck-stale">
                  <summary><b>{m.stale.checkouts.length}</b> old {m.stale.checkouts.length === 1 ? "worktree" : "worktrees"}{m.stale.files ? <> · <b>{m.stale.files}</b> uncommitted {m.stale.files === 1 ? "file" : "files"}</> : null}</summary>
                  <ul className="ck-rows">{m.stale.checkouts.map((c) => <Row key={c.id} c={c} onOpen={setOpenId} now={now} />)}</ul>
                </details>
              ) : null}
            </div>
          ))}
        </>
      )}
      {open ? (
        <PipelineDrawer label={`Checkout ${open.folder}`} onClose={() => setOpenId(null)}>
          <CheckoutDetails c={open} now={now} onShip={(s) => setShipping({ label: s.title, sessions: [s] })} />
        </PipelineDrawer>
      ) : null}
      {shipping ? <SwitchReview ledger={shipLedgerFor(flow, shipping.label, shipping.sessions.length)} onClose={() => setShipping(null)} onConfirm={ship} /> : null}
    </section>
  );
});

/** One checkout on one line: its light, where it is, its marks; the press opens it. A row that needs a person (`machine`)
 *  names its machine and keeps only what asks for them; its counts wait in the drawer. */
function Row({ c, machine = false, onOpen, now, children }: { c: CheckoutView; machine?: boolean; onOpen: (id: string) => void; now: number; children?: ReactNode }) {
  const working = c.sessions.filter((s) => s.state === "working").length;
  return (
    <li className="ck-row" data-tone={ledOf(c)}>
      <button type="button" className="ck-row-open" onClick={() => onOpen(c.id)} title={c.path} data-checkout-open>
        <i className="pv-led" data-tone={ledOf(c)} aria-hidden />
        <span className="ck-where">
          <span className="ck-folder">{c.folder}</span>
          {machine ? <span className="ck-machine">{c.machine}</span> : null}
          {c.branch && c.branch !== "main" ? <span className="ck-branch">{c.branch}</span> : null}
        </span>
        <span className="ck-marks">
          {c.level.tone === "stuck" ? (
            <>
              <span className="ck-stuck" title={c.level.reason ?? undefined}>{c.level.words}</span>
              <span className="ck-told" data-tone={c.level.told === "nobody told yet" ? "bad" : undefined} title={c.level.told ?? undefined}>{c.level.toldBrief}</span>
            </>
          ) : null}
          {working ? <span data-tone="live"><b>{working}</b> working</span> : null}
          {machine ? null : <>
          {c.ahead ? <span><b>{c.ahead}</b> ahead</span> : null}
          {c.behind ? <span><b>{c.behind}</b> behind</span> : null}
          {c.total ? <span><b>{c.total}</b> {c.total === 1 ? "file" : "files"}</span> : null}
          {!c.holdsWork && c.level.tone === "ok" ? <span>level{c.fetchedAt ? ` · ${agoWords(c.fetchedAt, now)}` : ""}</span> : null}
          </>}
        </span>
      </button>
      {children ? <span className="ck-action">{children}</span> : null}
    </li>
  );
}

const STATE_WORDS = { working: "working", idle: "idle", finished: "finished" } as const;

/** A checkout whole, in the drawer: where it stands, git's reason when stuck, and each session's work with its own Ship. */
function CheckoutDetails({ c, now, onShip }: { c: CheckoutView; now: number; onShip: (s: CheckoutSessionView) => void }) {
  return (
    <div className="pd-body">
      <div className="pd-crumb">{c.machine} · checkout</div>
      <h2 className="pd-title pv-mono">{c.folder}</h2>
      <dl className="pd-kv">
        <dt>Branch</dt>
        <dd>{c.branch ?? "no branch (detached)"}</dd>
        <dt>Against main</dt>
        <dd>{[c.ahead ? `${c.ahead} ahead` : null, c.behind ? `${c.behind} behind` : null].filter(Boolean).join(" · ") || "even"}{c.fetchedAt ? ` · fetched ${agoWords(c.fetchedAt, now)}` : ""}</dd>
        <dt>Kept level</dt>
        <dd>{c.level.tone === "stuck" ? `stuck ${c.level.since ? agoWords(c.level.since, now).replace(/ ago$/, "") : ""}` : c.level.words}</dd>
        {c.level.told ? <><dt>Told</dt><dd>{c.level.told}</dd></> : null}
        <dt>Uncommitted</dt>
        <dd>{plural(c.total, "file")}</dd>
      </dl>
      {c.level.tone === "stuck" ? (
        <>
          <div className="pd-sec">Why it is stuck</div>
          <pre className="pd-pre">{c.level.reason}</pre>
          <div className="pd-sec">{plural(c.level.files.length, "file")} in the way</div>
          <pre className="pd-pre">{c.level.files.join("\n")}</pre>
        </>
      ) : null}
      {c.sessions.length ? <div className="pd-sec">Work by session · {c.sessions.length}</div> : null}
      {c.sessions.map((s) => (
        <div key={s.key} className="pd-row ck-work" data-state={s.state}>
          <span className="ck-work-state">{STATE_WORDS[s.state]}</span>
          {s.conversationId ? <Link href={`/conversation/${s.conversationId}`} className="pd-run-title">{s.title}</Link> : <span className="pd-run-title">{s.title}</span>}
          <Files paths={s.paths} more={s.more} />
          <span className="pd-dim">{agoWords(s.lastActivity, now)}</span>
          {s.canShip ? <button type="button" className="pv-btn ck-ship" onClick={() => onShip(s)} data-checkout-ship>Ship</button> : null}
        </div>
      ))}
      {c.unattributed.paths.length ? (
        <>
          <div className="pd-sec">{c.unattributed.reading ? "Reading who wrote these" : "Edits no session wrote"}</div>
          <Files paths={c.unattributed.paths} more={c.unattributed.more} open />
        </>
      ) : null}
    </div>
  );
}

/** A group's files: how many, opening to the paths. */
function Files({ paths, more, open = false }: { paths: string[]; more: number; open?: boolean }) {
  const n = paths.length + more;
  return (
    <details className="ck-files" open={open}>
      <summary><b>{n}</b> {n === 1 ? "file" : "files"}</summary>
      <ul>{paths.map((p) => <li key={p}>{p}</li>)}{more ? <li className="pd-dim">+{more} more</li> : null}</ul>
    </details>
  );
}
