"use client";
// Every device's checkouts of the repository, under its pipeline (ct-98780).
// What needs a person leads, in one red: a stuck checkout (why, in a glance)
// and one far behind main with uncommitted work, each with its one action:
// tell the session that wrote the stuck files, file a finding for the files
// nobody wrote, or ship. Finished work nobody shipped is one folded line with
// Ship all. Then each machine's live checkouts as one row apiece, and its old
// worktrees folded into one line. A row opens the checkout in the page's
// drawer: why it is stuck in words, the files by folder, each writer with its
// own Tell, each session's work with its own Ship. Ship asks the session to run
// its change through the repo's change flow (the same message RunThroughFlow
// sends from a session's header), in one click; what started follows the press.
// It confirms first only where the flow asks the person on every run, the
// checkout is a risk to ship from, or several runs would start at once.
import { memo, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useCheckouts, useSyncCheckouts } from "../../../hooks/useSyncCheckouts";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useInboxStore } from "../../../store/inboxStore";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { shipLedgerFor } from "../../consequential/shipLedger";
import { PRESS_WAIT_MS, runThroughMessage } from "../../../lib/line/flowMessages";
import { approvalOf, shipConfirms } from "../../../lib/ship/approval";
import { agoWords, drawnFlow, pipelineModel } from "../../../lib/line/pipelineModel";
import { trackOf } from "../../../lib/line/pipelineView";
import { checkoutsPage, checkoutsSummary, filesByFolder, type CheckoutSessionView, type CheckoutView } from "../../../lib/line/checkoutsModel";
import type { Pipeline } from "../../../lib/line/pipelineTypes";
import { toldOf } from "@codecast/shared/contracts/checkouts";
import { PipelineDrawer } from "./PipelineDrawer";
import { PipelineTrack } from "./PipelineTrack";

type TitleRow = { title?: string | null };
type Shipping = { label: string; sessions: CheckoutSessionView[]; from: string | null };

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A checkout's light: one red for what needs a person, then work to ship, someone working in it, level, or left alone. */
const ledOf = (c: CheckoutView) => (c.place === "needs" ? "stuck" : c.finished.length ? "waiting" : c.sessions.some((s) => s.state === "working") ? "going" : c.level.tone === "ok" ? "current" : "off");

/** Where a ship starts from, said when it is a risk: far behind main, or conflicting with it. */
const fromWords = (c: CheckoutView) =>
  c.farBehind || c.level.tone === "stuck"
    ? [c.machine, c.behind ? `${c.behind.toLocaleString("en-US")} behind main` : null, c.level.tone === "stuck" && c.level.heading?.startsWith("Conflicts") ? `conflicts in ${plural(c.level.files.length, "file")}` : null].filter(Boolean).join(", ")
    : null;

const ask = (id: string, who: string) => useInboxStore.getState().askCheckout(id, who, Date.now());

export const CheckoutsSection = memo(function CheckoutsSection({ pipeline, teamId }: { pipeline: Pipeline; teamId: string | null }) {
  const { ready, error, refused } = useSyncCheckouts(teamId);
  const rows = useCheckouts(teamId, pipeline.repository);
  const now = useCoarseNow(60_000);
  // Sessions by their titles in this viewer's store: a team row never carries a private session's title.
  const ids = useMemo(() => [...new Set(rows.flatMap((r) => [...r.uncommitted.sessions.map((s) => s.conversation_id), ...(r.level.state === "stuck" ? toldOf(r.level).map((t) => (t.to === "session" ? t.conversation_id : null)) : [])]).filter((x): x is string => !!x))].sort().join(","), [rows]);
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
  // The confirm draws the change lane as the page does, read-only, from the stations on (the session is where it comes from).
  const lane = useMemo(() => trackOf(pipelineModel(pipeline), "change").filter((it) => !(it.type === "pill" && it.id === null)), [pipeline]);
  const laneLabels = useMemo(() => new Map(lane.flatMap((it) => (it.type === "fork" ? it.branches : [it])).filter((p) => p.id).map((p) => [p.id!, p.label])), [lane]);
  const [shipping, setShipping] = useState<Shipping | null>(null);
  // The ledger of a ship that went in one click: what started, shown after the press instead of before it.
  const [shipped, setShipped] = useState<Shipping | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const all = [...page.needs, ...page.ready, ...page.machines.flatMap((m) => [...m.live, ...m.stale.checkouts])];
  const open = openId ? all.find((c) => c.id === openId) ?? null : null;
  const readySessions = page.ready.flatMap((c) => c.finished);

  // Each session is asked once: a second press (a double click, the row's Ship after the drawer's) sends nothing more,
  // and its buttons say it is starting. A session that starts its run is working, so it leaves the finished list; one
  // that does not is free to ask again after a minute.
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());
  const isSent = (s: CheckoutSessionView) => !!s.conversationId && sent.has(s.conversationId);
  const send = (sh: Shipping) => {
    const ids = sh.sessions.map((s) => s.conversationId).filter((id): id is string => !!id && !sent.has(id));
    if (!ids.length) return;
    for (const id of ids) useInboxStore.getState().sendMessage(id, runThroughMessage(flow));
    setSent((prev) => new Set([...prev, ...ids]));
    setTimeout(() => setSent((prev) => new Set([...prev].filter((id) => !ids.includes(id)))), PRESS_WAIT_MS);
  };
  const go = (sh: Shipping) => {
    sh = { ...sh, sessions: sh.sessions.filter((s) => !isSent(s)) };
    if (!sh.sessions.length) return;
    if (shipConfirms(approvalOf(flow), { from: sh.from, runs: sh.sessions.length })) return setShipping(sh);
    send(sh);
    setShipped(sh);
  };
  const shipAll = (c: CheckoutView) => go({ label: c.finished.length === 1 ? c.finished[0].title : `${plural(c.finished.length, "finished session")} in ${c.folder}`, sessions: c.finished, from: fromWords(c) });
  const ship = () => {
    if (shipping) send(shipping);
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
              <div className="ck-group-name">Needs you · {page.needs.length}</div>
              <ul className="ck-rows">
                {page.needs.map((c) => <Row key={c.id} c={c} machine onOpen={setOpenId} now={now}><NeedsAction c={c} onOpen={setOpenId} onShip={shipAll} sent={c.finished.every(isSent)} /></Row>)}
              </ul>
            </div>
          ) : null}
          {page.ready.length ? (
            <details className="ck-group ck-ready" data-group="ready">
              <summary className="ck-ready-head">
                <span className="ck-group-name">Ready to ship · {readySessions.length}</span>
                <span className="ck-ready-where">{plural(page.ready.length, "checkout")}</span>
                <button type="button" className="pv-btn ck-primary" data-checkout-ship-all
                  onClick={(e) => { e.preventDefault(); setShipping({ label: `${plural(readySessions.length, "finished session")} in ${plural(page.ready.length, "checkout")}`, sessions: readySessions, from: null }); }}>
                  Ship all
                </button>
              </summary>
              <ul className="ck-rows">
                {page.ready.map((c) => (
                  <Row key={c.id} c={c} machine onOpen={setOpenId} now={now}>
                    <button type="button" className="pv-btn" onClick={() => shipAll(c)} disabled={c.finished.every(isSent)} data-checkout-ship>{c.finished.every(isSent) ? "Starting…" : `Ship${c.finished.length > 1 ? ` ${c.finished.length}` : ""}`}</button>
                  </Row>
                ))}
              </ul>
            </details>
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
          <CheckoutDetails c={open} now={now} isSent={isSent} onShip={(s) => go({ label: s.title, sessions: [s], from: fromWords(open) })} />
        </PipelineDrawer>
      ) : null}
      {shipped ? <ShippedNote ledger={shipLedgerFor(flow, shipped.label, shipped.sessions.length, { drawn: true, labelOf: (id) => laneLabels.get(id) })} onClose={() => setShipped(null)} /> : null}
      {shipping ? (
        <SwitchReview ledger={shipLedgerFor(flow, shipping.label, shipping.sessions.length, { drawn: true, from: shipping.from, labelOf: (id) => laneLabels.get(id) })} onClose={() => setShipping(null)} onConfirm={ship}>
          <div className="ck-confirm-lane lw-widget" data-ship-lane><PipelineTrack items={lane} small /></div>
        </SwitchReview>
      ) : null}
    </section>
  );
});

/** A one-click ship's ledger, after the press: what it started and what may still stop it, dismissed when read. */
function ShippedNote({ ledger: l, onClose }: { ledger: ReturnType<typeof shipLedgerFor>; onClose: () => void }) {
  return (
    <div className="ck-shipped" role="status" data-checkout-shipped>
      <b>{l.name}</b>
      <span className="ck-shipped-subject">{l.subject}</span>
      <ul>{l.rows.map((r) => <li key={r.k}><span>{r.k}</span> {r.v}</li>)}</ul>
      <button type="button" className="pv-btn" onClick={onClose} data-checkout-shipped-close>OK</button>
    </div>
  );
}

/** What a checkout that needs a person asks of them: tell the writers not yet told, file what nobody wrote, ship, or look. */
function NeedsAction({ c, onOpen, onShip, sent }: { c: CheckoutView; onOpen: (id: string) => void; onShip: (c: CheckoutView) => void; sent: boolean }) {
  if (c.asks) {
    const untold = c.asks.writers.filter((w) => !w.told);
    if (untold.length) {
      return <button type="button" className="pv-btn ck-primary" onClick={() => { for (const w of untold) ask(c.id, w.conversationId); }} title={untold.map((w) => w.title).join("\n")} data-checkout-tell>{untold.length === 1 ? "Tell writer" : `Tell ${untold.length} writers`}</button>;
    }
    if (c.asks.nobody.files.length && !c.asks.nobody.told) {
      // Until the daemon knows who wrote the files, the ones it calls nobody's are not settled: no finding yet.
      if (c.unattributed.reading) return <span className="ck-told">reading who wrote them</span>;
      return <button type="button" className="pv-btn" onClick={() => ask(c.id, "finding")} data-checkout-finding>File a finding</button>;
    }
    return <span className="ck-told" title={c.level.told ?? undefined}>{c.level.toldBrief}</span>;
  }
  if (c.finished.length) return <button type="button" className="pv-btn" onClick={() => onShip(c)} disabled={sent} data-checkout-ship>{sent ? "Starting…" : `Ship${c.finished.length > 1 ? ` ${c.finished.length}` : ""}`}</button>;
  return <button type="button" className="pv-btn" onClick={() => onOpen(c.id)}>Open</button>;
}

/** One checkout on one line: its light, where it is, its marks; the press opens it. A row in a group (`machine`) names
 *  its machine and keeps only what asks for a person; its counts wait in the drawer. */
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
          {c.level.tone === "stuck" ? <span className="ck-stuck" title={c.level.reason ?? undefined}>{c.level.words}</span> : null}
          {c.farBehind && c.level.tone !== "stuck" ? <span className="ck-stuck">{c.behind!.toLocaleString("en-US")} behind · {plural(c.total, "uncommitted file")}</span> : null}
          {working ? <span data-tone="live"><b>{working}</b> working</span> : null}
          {c.place === "ready" ? <span><b>{c.finished.length}</b> finished</span> : null}
          {machine ? null : <>
          {c.ahead ? <span><b>{c.ahead}</b> ahead</span> : null}
          {c.behind ? <span><b>{c.behind.toLocaleString("en-US")}</b> behind</span> : null}
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

/** A checkout whole, in the drawer: the action it asks for first, where it stands, why it is stuck in words with each
 *  writer's files, and each session's work with its own Ship. */
function CheckoutDetails({ c, now, onShip, isSent }: { c: CheckoutView; now: number; onShip: (s: CheckoutSessionView) => void; isSent: (s: CheckoutSessionView) => boolean }) {
  const last = c.asks?.writers.find((w) => !w.told) ?? null;
  const nobodyUntold = !!c.asks && c.asks.nobody.files.length > 0 && !c.asks.nobody.told && !c.unattributed.reading;
  return (
    <div className="pd-body">
      <div className="pd-crumb">{c.machine} · checkout</div>
      <h2 className="pd-title pv-mono">{c.folder}</h2>
      {last || nobodyUntold ? (
        <div className="ck-acts" data-checkout-acts>
          {last ? <button type="button" className="pv-btn ck-primary" onClick={() => ask(c.id, last.conversationId)} data-checkout-tell>Tell {last.title}</button> : null}
          {nobodyUntold ? <button type="button" className="pv-btn" onClick={() => ask(c.id, "finding")} data-checkout-finding>File a finding</button> : null}
        </div>
      ) : null}
      <dl className="pd-kv ck-kv">
        <dt>Branch</dt>
        <dd>{c.branch ?? "no branch (detached)"}</dd>
        <dt>Against main</dt>
        <dd data-tone={c.farBehind ? "bad" : undefined}>{[c.ahead ? `${c.ahead.toLocaleString("en-US")} ahead` : null, c.behind ? `${c.behind.toLocaleString("en-US")} behind` : null].filter(Boolean).join(" · ") || "even"}{c.fetchedAt ? ` · fetched ${agoWords(c.fetchedAt, now)}` : ""}</dd>
        <dt>Syncing</dt>
        <dd data-tone={c.level.tone === "stuck" ? "bad" : undefined}>{c.level.tone === "stuck" ? `stuck ${c.level.stuckFor}` : c.level.words}</dd>
        <dt>Uncommitted</dt>
        <dd>{plural(c.total, "file")}</dd>
      </dl>
      {c.level.tone === "stuck" && c.asks ? (
        <>
          <h3 className="ck-heading">{c.level.heading}</h3>
          {c.level.heading?.startsWith("Conflicts") ? null : <p className="ck-reason">{c.level.reason}</p>}
          {c.asks.writers.map((w) => (
            <div key={w.conversationId} className="ck-writer">
              <div className="ck-writer-head">
                <Link href={`/conversation/${w.conversationId}`} className="ck-writer-name">{w.title}</Link>
                <span className="pd-dim">{plural(w.files.length, "file")}</span>
                {w.told ? <span className="ck-writer-told">told</span> : <button type="button" className="pv-btn ck-small" onClick={() => ask(c.id, w.conversationId)} data-checkout-tell>Tell</button>}
              </div>
              <FolderFiles paths={w.files} />
            </div>
          ))}
          {c.asks.nobody.files.length ? (
            <div className="ck-writer">
              <div className="ck-writer-head">
                <span className="ck-writer-name" data-quiet>No session wrote</span>
                <span className="pd-dim">{plural(c.asks.nobody.files.length, "file")}</span>
                {c.asks.nobody.told ? <span className="ck-writer-told">finding filed</span>
                  : c.unattributed.reading ? <span className="ck-writer-told">reading who wrote them</span>
                  : <button type="button" className="pv-btn ck-small" onClick={() => ask(c.id, "finding")} data-checkout-finding>File a finding</button>}
              </div>
              <FolderFiles paths={c.asks.nobody.files} />
            </div>
          ) : null}
        </>
      ) : null}
      {c.sessions.length ? <div className="pd-sec">Work by session · {c.sessions.length}</div> : null}
      {c.sessions.map((s) => (
        <div key={s.key} className="pd-row ck-work" data-state={s.state}>
          <span className="ck-work-state">{STATE_WORDS[s.state]}</span>
          {s.conversationId ? <Link href={`/conversation/${s.conversationId}`} className="pd-run-title">{s.title}</Link> : <span className="pd-run-title">{s.title}</span>}
          <Files paths={s.paths} more={s.more} />
          <span className="pd-dim">{agoWords(s.lastActivity, now)}</span>
          {s.canShip ? <button type="button" className="pv-btn ck-ship" onClick={() => onShip(s)} disabled={isSent(s)} data-checkout-ship>{isSent(s) ? "Starting…" : "Ship"}</button> : null}
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

/** Paths under their folders, eight file rows then how many more: a file name is never broken, a folder may shorten. */
function FolderFiles({ paths }: { paths: string[] }) {
  const [all, setAll] = useState(false);
  const { groups, more } = filesByFolder(paths, all ? paths.length : 8);
  return (
    <ul className="ck-folders">
      {groups.map((g, i) => (
        <li key={`${g.folder}${i}`}>
          {g.folder ? <span className="ck-folder-path" title={g.folder}><bdi dir="ltr">{g.folder}</bdi></span> : null}
          {g.names.map((n) => <span key={n} className="ck-file" title={`${g.folder}${n}`}>{n}</span>)}
        </li>
      ))}
      {more ? <li><button type="button" className="ck-more" onClick={() => setAll(true)}>+{more} more</button></li> : null}
    </ul>
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
