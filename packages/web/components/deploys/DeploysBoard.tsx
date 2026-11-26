"use client";
// One target on the Deploys page (doc s97bnygafm0x6p6cwn1f5bn6258jyjfa): its head (what is live, Mine, Roll back,
// Pause), the production pause, the chip a link names, and two columns. Shipping: changes sent through Ship and not on
// main yet. Deploys: Next deploy and every deploy, one card kind, each listing what it carried by session, PR, SHA,
// task, branch or priority, every commit credited to the session that pressed Ship. Drawn from props alone
// (lib/deploys/board.ts derives everything), so a fixture renders it; only an opened deploy's detail reads the store.
import { useMemo, useState } from "react";
import { Check, ChevronRight, GitBranch, Loader2, Pause, RotateCcw, X } from "lucide-react";
import type { CommitCiState, ShippingRun, ShippingShipper } from "@codecast/shared/contracts/deployTargets";
import type { CheckoutRow } from "@codecast/shared/contracts/checkouts";
import type { DeployReach } from "@codecast/shared/contracts/deployReach";
import type { DeployPauseView } from "@codecast/shared/contracts/deployPause";
import { entityRoute } from "@codecast/shared/entities";
import {
  VIEWS, ago, attemptGroups, carriedOfAttempts, carriedOfQueue, fold, mineSessionIds, queueCommits, recordedOf, rowsFor, shipperOf, shippingRuns, splitQueue, tasksOnMain, yourSessions,
  type BoardDeploy, type BoardQueueCommit, type BoardRow, type BoardView, type Bucket, type CardId, type Carried, type DeployCard as Card, type DeployLine,
} from "../../lib/deploys/board";
import { carriedMatches, commitMatches, deployMatches, focusWord, reachDeployOn, rowMatches, runMatches, type DeployFocus } from "../../lib/deploys/focus";
import { isOpen, rebuiltOnly, rollbackTarget, sessionWords, sessionsOf, sourceWord, targetNow, type DeployProductionRow, type DeployTargetRow, type TeamDeployRow } from "../../lib/deploys/targets";
import { rollBackHere, rollbackOffer, type Press, type RollbackPress } from "../../lib/deploys/press";
import { landFocus } from "../../lib/deploys/landFocus";
import { ageShort } from "../../lib/lineFlow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useDeployDetail, useSyncDeployDetail } from "../../hooks/useDeployDetail";
import { changeGroups, devPushWords, hasChangeNames, originWords, shownNames, type ChangeGroup } from "./deployRecord";
import { ShippingColumn } from "./ShippingColumn";
import { EntityIdPill } from "../EntityIdPill";
import { ShareControl } from "../ShareControl";
import "./deploys.css";

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Where a deploy's own log is, named by its host. */
const logWord = (d: Pick<TeamDeployRow, "source" | "url">) => `${sourceWord(d)} log`;

const VIEW_WORDS: Record<BoardView, { word: string; rows: string }> = {
  sessions: { word: "Sessions", rows: "sessions" },
  prs: { word: "PRs", rows: "pull requests" },
  shas: { word: "SHAs", rows: "commits" },
  tasks: { word: "Tasks", rows: "tasks" },
  branches: { word: "Branches", rows: "branches" },
  priorities: { word: "Priorities", rows: "priorities" },
};

/** Cards shown before "Earlier deploys". */
const CARDS_SHOWN = 6;

export type DeploysBoardProps = {
  target: DeployTargetRow;
  production: DeployProductionRow | undefined;
  /** The team's deploys (the board reads this target's). */
  deploys: ReadonlyArray<TeamDeployRow>;
  /** workflow_runs.shippingRuns: Ship runs on their way, and who pressed Ship on recent runs; null while it is read. */
  shipping: { runs: ReadonlyArray<ShippingRun>; shippers: ReadonlyArray<ShippingShipper> } | null;
  /** The Ship runs could not be read (a backend without the query yet): Shipping says so; nothing is credited. */
  shippingError?: boolean;
  /** deployRefs.deployLines by deploy id, for the cards shown: their commits' lines, PR and branch ("—" until read). */
  linesByDeploy?: ReadonlyMap<string, ReadonlyArray<DeployLine>>;
  /** The deploys whose lines the cards now shown want, each time that set changes. */
  onLinesWanted?: (deployIds: string[]) => void;
  /** The team's checkouts: a run with no PR yet finds its repository and branch by the one it runs in. */
  checkouts: ReadonlyArray<Pick<CheckoutRow, "path" | "repository" | "branch" | "upstream">>;
  /** The viewer's user id: Mine, the blue dot and "Your sessions". */
  me: string | null;
  now: number;
  /** The team has priorities on: the switch offers Priorities. */
  priorities: boolean;
  /** What a link points at, where reach says it went, and a deploy a link opens. */
  focus: DeployFocus | null;
  reach: DeployReach | null;
  openDeploy: string | null;
  show: BoardView;
  mine: boolean;
  onShow: (v: BoardView) => void;
  onMine: (on: boolean) => void;
  onClearFocus: () => void;
  onPress: (p: Press) => void;
  onRollback: (p: RollbackPress) => void;
  onPause: () => void;
  onLift: () => void;
};

export function DeploysBoard(p: DeploysBoardProps) {
  const { target: t, production, now, focus, mine, me } = p;
  const show = p.show === "priorities" && !p.priorities ? "sessions" : p.show;
  const n = useMemo(() => targetNow(t, p.deploys), [t, p.deploys]);
  const history = n.history as BoardDeploy[];
  const queue = useMemo(() => queueCommits(t.queue.groups), [t.queue.groups]);
  const shippers = p.shipping?.shippers;
  const lines = p.linesByDeploy;
  const board = useMemo(() => {
    const credit = shipperOf(shippers ?? []);
    const { going, sending, next: nextCommits } = splitQueue(queue, history);
    // The commits the queue counted but did not list are the oldest waiting: Next deploy's while nothing is going out,
    // else the going-out deploy's (it sends everything up to its own commit).
    const older = Math.max(0, t.queue.commits - t.queue.shown);
    // Only a deploy actually sending the queue takes them; a rollback or an old request at an unlisted sha does not.
    const sends = !!going && sending.length > 0;
    const unlisted = sends ? 0 : older;
    const next = nextCommits.length ? carriedOfQueue(nextCommits, credit, unlisted) : null;
    const cards: Card[] = attemptGroups(history).map((g) => ({ deploys: g, carried: carriedOfAttempts(g, queue, credit, lines, sends && g[0] === going ? older : 0) }));
    const mineIds = mineSessionIds([next, ...cards.map((c) => c.carried)], me);
    // Every pull request whose commit is on main, waiting or deployed (from the cards' commits).
    const landedPrs = new Set<number>([next, ...cards.map((c) => c.carried)].flatMap((c) => (c ? c.commits.flatMap((x) => (x.pr ? [x.pr] : [])) : [])));
    for (const c of queue) if (c.pr_number) landedPrs.add(c.pr_number);
    return { queue, going, nextCommits, next, unlisted, cards, mineIds, landedPrs, your: yourSessions(next, cards, mineIds), onMain: tasksOnMain(queue, history) };
  }, [queue, history, shippers, lines, t.queue.commits, t.queue.shown, me]);

  // Where the linked thing is: waiting in the queue, or on the deploys that took it out (reach names the one that holds
  // a PR or commit; anything else is matched on what each deploy carried), or on a Ship run on its way.
  const focusWaiting = !!focus && queue.some((c) => commitMatches(c, focus));
  const held = reachDeployOn(p.reach, t.name);
  const focusDeploys = !focus ? [] : held ? history.filter((d) => d.short_id === held.short_id) : history.filter((d) => deployMatches(d, focus));
  const runs = p.shipping?.runs ?? null;
  const shipping = useMemo(() => (runs ? shippingRuns(runs, { repository: t.repository, checkouts: p.checkouts, now }) : null), [runs, t.repository, p.checkouts, now]);
  const coming: FocusComing = !focus || focusWaiting || focusDeploys.length ? null
    : !shipping ? (p.shippingError ? null : "reading") : shipping.moving.some((r) => runMatches(r, focus)) ? "coming" : shipping.dropped.some((r) => runMatches(r, focus)) ? "parked" : null;
  // A link brings what it names on screen and flashes it, wherever it is in either column; the rows find themselves.
  const focusKey = focus ? `${focus.kind}:${focusWord(focus)}` : null;
  useWatchEffect(() => (focusKey ? landFocus() : undefined), [focusKey]);

  const back = rollbackTarget(n.history, n.live);
  const backPaused = t.workflow ? rollbackOffer(back, t, production, p.deploys) : null;
  const pause = production?.pause ?? null;
  const waiting = t.queue.commits;
  return (
    <section className="dpp-main" data-deploy-pane={t.name}>
      <header className="dpp-head">
        <div className="dpp-head-name">
          <h2>{t.name}</h2>
          <span className="dpp-policy" data-policy={t.policy}>{t.record_only ? "from its deploy records" : t.runs === "push" ? "on every push" : t.policy === "auto" ? "on green CI" : t.policy === "release" ? "with every release" : "on a press"}</span>
        </div>
        <div className="dpp-live">
          <span className="dpp-head-sub">{t.repository}</span>
          <span className="dpp-k">Live</span>
          {n.live ? (
            <span className="dpp-v"><code>{short(n.live.sha)}</code>{n.live.version && !(n.live.sha ?? "").startsWith(n.live.version.slice(0, 7)) ? <span className="dpp-ver">{n.live.version}</span> : null}<span className="dpp-dp">{n.live.short_id}</span><span className="dpp-age">{ago(now, n.live.live_at ?? n.live.created_at)}</span></span>
          ) : <span className="dpp-v dpp-dim">no live version known</span>}
          {t.dev_push ? <span className="dpp-devpush" data-deploy-dev-push={t.name}>{devPushWords(t.dev_push, now)}</span> : null}
        </div>
        <div className="dpp-actions">
          <button type="button" className="dpp-mine" aria-pressed={mine} onClick={() => p.onMine(!mine)} title="Only your work and your sessions, in both columns" data-deploy-mine>Mine</button>
          {!t.record_only && t.runs !== "push" && waiting === 0 && !n.open && t.queue.known ? <span className="dpp-current" data-deploy-current={t.name}><Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden />Up to date</span> : null}
          {backPaused ? (
            <button type="button" className="dpp-back" aria-haspopup="dialog" onClick={() => p.onRollback(backPaused)} data-deploy-rollback={t.name}>
              <RotateCcw className="w-3 h-3" aria-hidden />Roll back to {short(backPaused.of.sha)}
            </button>
          ) : !t.workflow && back && (t.can_redeploy_sha || t.can_rollback) && !n.open ? (
            <button type="button" className="dpp-back" onClick={() => p.onPress({ target: t, action: t.can_rollback ? "rollback" : "redeploy", of: back })} data-deploy-rollback={t.name}>
              <RotateCcw className="w-3 h-3" aria-hidden />Roll back to {short(back.sha)}
            </button>
          ) : null}
          {production?.can_pause && !pause && !t.record_only ? (
            <button type="button" className="dpp-back" aria-haspopup="dialog" onClick={p.onPause} data-deploy-pause={t.repository}>
              <Pause className="w-3 h-3" aria-hidden />Pause
            </button>
          ) : null}
        </div>
      </header>

      {pause ? <Paused p={pause} canLift={!!production?.can_lift} now={now} onLift={p.onLift} /> : null}
      {focus ? <FocusChip focus={focus} repository={t.repository} waiting={focusWaiting} coming={coming} deploys={focusDeploys} live={n.live} onClear={p.onClearFocus} /> : null}

      {/* Shipping on the left, Deploys on the right once the page is wide (deploys.css), each its own scroll; narrower, Deploys comes first. */}
      <div className="dpp-body">
        {t.record_only ? null : (
          <div className="dpp-col" data-deploy-col="before">
            <ShippingColumn runs={runs} shippers={shippers ?? []} error={!!p.shippingError} checkouts={p.checkouts} repository={t.repository} now={now} me={me} mine={mine} focus={focus} onMain={board.onMain} landedPrs={board.landedPrs} />
          </div>
        )}
        <div className="dpp-col" data-deploy-col="after">
          <DeploysColumn {...p} show={show} n={n} board={board} focusDeploys={focusDeploys} />
        </div>
      </div>
    </section>
  );
}

type BoardModel = {
  queue: BoardQueueCommit[];
  going: BoardDeploy | null;
  nextCommits: ReturnType<typeof splitQueue>["next"];
  next: Carried | null;
  unlisted: number;
  cards: Card[];
  mineIds: Set<string>;
  your: ReturnType<typeof yourSessions>;
};

function DeploysColumn(p: DeploysBoardProps & { n: ReturnType<typeof targetNow>; board: BoardModel; focusDeploys: TeamDeployRow[] }) {
  const { target: t, production, now, focus, mine, show, n, board, focusDeploys } = p;
  const { going, nextCommits, next, cards, mineIds, your } = board;
  const isMine = (id: string) => mineIds.has(id);
  const mineCard = (c: Carried | null) => !!c?.sessions.some((s) => mineIds.has(s.id));
  const cardFocus = (c: Card) => !!focus && (c.deploys.some((d) => focusDeploys.includes(d)) || c.carried.commits.some((x) => carriedMatches(x, focus)));
  // Mine narrows the cards to those holding one of the viewer's sessions; the card a link points at always stays.
  const shown = mine ? cards.filter((c) => mineCard(c.carried) || cardFocus(c)) : cards;
  // The card a link points at is always drawn, even when reach or a feed finds it after the page opened.
  const firstFocused = shown.findIndex(cardFocus);
  const [extra, setExtra] = useState(0);
  const limit = Math.max(CARDS_SHOWN + extra, firstFocused + 1);
  // Lines are read only for the cards on screen, by the attempt each lists.
  const wanted = shown.slice(0, limit).flatMap((c) => { const d = recordedOf(c.deploys, board.queue); return d?.commit_rows?.length ? [d._id] : []; }).join(",");
  const onLinesWanted = p.onLinesWanted;
  useWatchEffect(() => { onLinesWanted?.(wanted ? wanted.split(",") : []); }, [wanted, onLinesWanted]);
  const total = n.history.length;
  const count = mine ? `${shown.reduce((k, c) => k + c.deploys.length, 0)} of ${total}` : String(total);
  const nextFocus = !!focus && nextCommits.some((c) => commitMatches(c, focus));
  const showNext = !t.record_only && (!!next || !t.queue.known);
  const views = VIEWS.filter((v) => v !== "priorities" || p.priorities);
  return (
    <section className="dpp-sec" data-deploy-deploys>
      <h3 className="dpp-colhead">
        Deploys<span className="dpp-num" data-deploy-count>{count}</span>
        {t.record_only ? null : <a className="dpp-jump" href="#dpp-shipping">Shipping ↓</a>}
        <span className="dpp-labels dpp-switch" role="group" aria-label="What each deploy lists" data-deploy-switch>
          {views.map((v) => <button key={v} type="button" aria-pressed={show === v} onClick={() => p.onShow(v)} data-deploy-view={v}>{VIEW_WORDS[v].word}</button>)}
        </span>
      </h3>
      <YourSessions buckets={your.buckets} />
      <ul className="dpp-cards">
        {showNext ? (
          <li className="dpp-card" id="deploy-next" data-kind="next" data-focus={nextFocus && !(next && rowsHold(next, show, isMine, focus)) ? "" : undefined} data-deploy-card="next">
            <div className="dpp-card-head">
              <b className="dpp-card-title">Next deploy</b>
              <span className="dpp-meta">
                {t.queue.known
                  ? <span className="dpp-fact">{plural(nextCommits.length + board.unlisted, "commit")} on main{going ? ` after ${going.short_id}` : n.live ? ` after ${n.live.short_id}` : ""}</span>
                  : <span className="dpp-fact" data-deploy-queue-unknown>Live <code>{short(n.live?.sha)}</code> is not on main, so what waits here can't be counted</span>}
                {nextCommits.length ? <HeadCi ci={t.queue.head_ci} url={t.queue.head_ci_url} /> : null}
              </span>
              <span className="dpp-card-end"><DeployButton t={t} production={production} n={n} onPress={p.onPress} /></span>
            </div>
            {next ? <CarriedList carried={next} view={show} mine={mine} isMine={isMine} newer={your.newer} self="next" focus={focus} repository={t.repository} /> : null}
          </li>
        ) : null}
        {shown.slice(0, limit).map((c) => (
          <DeployCard key={c.deploys[0]._id} card={c} {...p} view={show} live={n.live} isMine={isMine} newer={your.newer} focused={cardFocus(c)} />
        ))}
        {shown.length > limit ? (
          <li>
            <button type="button" className="dpp-fold dpp-older" onClick={() => setExtra(limit - CARDS_SHOWN + 20)} data-deploy-older={shown.length - limit}>
              <ChevronRight className="dpp-chev" aria-hidden />Earlier deploys<span className="dpp-pick-n">{shown.length - limit}</span>
            </button>
          </li>
        ) : null}
        {!showNext && !shown.length ? <li className="dpp-card dpp-card--none">{mine ? "None of yours" : "No deploys yet"}</li> : null}
      </ul>
    </section>
  );
}

/** Where each of the viewer's sessions is now, each part a link to the card that holds it. */
function YourSessions({ buckets }: { buckets: Record<Bucket, { count: number; card: CardId | null }> }) {
  const parts = ([["waiting", "waiting to deploy"], ["going", "going out"], ["live", "live"]] as const).filter(([b]) => buckets[b].count);
  if (!parts.length) return <p className="dpp-sub" data-deploy-yours="">None of your sessions are in these deploys</p>;
  return (
    <p className="dpp-sub" data-yours data-deploy-yours={parts.map(([b]) => `${b}:${buckets[b].count}`).join(",")}>
      <i className="dpp-you" aria-hidden />
      <span>Your sessions: {parts.map(([b, words], i) => <span key={b} className="dpp-part">{i ? " · " : ""}<a href={`#deploy-${buckets[b].card}`}>{buckets[b].count} {words}</a></span>)}</span>
    </p>
  );
}

/** The press that sends what waits: one click into the confirm flow (useDeployPress), or why it can't go now. */
function DeployButton({ t, production, n, onPress }: { t: DeployTargetRow; production: DeployProductionRow | undefined; n: ReturnType<typeof targetNow>; onPress: (p: Press) => void }) {
  if (t.runs === "push") return <span className="dpp-auto">goes out when main moves</span>;
  const pause = production?.pause ?? null;
  const blocked = pause ? "Production is paused" : n.open ? `${n.open.short_id || "A deploy"} is going out` : !t.can_deploy ? "No machine publishes it" : t.queue.known && t.queue.commits === 0 ? "Nothing waiting" : null;
  return (
    <button type="button" className="dpp-go" disabled={!!blocked} title={blocked ?? undefined} onClick={() => onPress({ target: t, action: "deploy", of: null })} data-deploy-go={t.name}>
      {t.queue.known ? "Deploy" : "Deploy main"}
    </button>
  );
}

function DeployCard({ card, view, mine, focus, now, target: t, production, deploys, live, isMine, newer, focused, openDeploy, onPress, onRollback }: DeploysBoardProps & {
  card: Card; view: BoardView; live: TeamDeployRow | null; isMine: (id: string) => boolean; newer: ReadonlyMap<string, CardId>; focused: boolean;
}) {
  const [lead, ...earlier] = card.deploys;
  const c = card.carried;
  // Which attempt's detail is open: the one a link names (any attempt on the card), else whichever the viewer opens.
  const [opened, setOpened] = useState<string | null>(card.deploys.some((d) => d.short_id === openDeploy) ? openDeploy : null);
  const openOne = card.deploys.find((d) => d.short_id === opened) ?? null;
  const toggle = (d: TeamDeployRow) => setOpened(opened === d.short_id ? null : d.short_id);
  const isLive = card.deploys.some((d) => d._id === live?._id);
  // A request with no commit carries nothing out: it is asked for, not going out (a stale one would say so forever).
  const going = isOpen(lead) && (lead.status === "running" || !!lead.sha);
  const at = lead.live_at ?? lead.created_at;
  const empty = !c.commits.length && !c.sessions.length;
  // A cancelled or failed attempt that sent nothing is one line: its pill already says what happened.
  const quiet = empty && (lead.status === "cancelled" || lead.status === "failed");
  const step = going ? (lead.steps?.find((s) => s.status === "running")?.id ?? "no step reported yet") : null;
  // Roll back here is offered on whichever attempt at this commit went live.
  const wentLive = card.deploys.find((d) => d.status === "live") ?? lead;
  const back = rollbackOffer(wentLive, t, production, deploys);
  const here = back ? null : rollBackHere(wentLive, t, deploys);
  // The card itself lights up when the view draws no row holding the linked thing.
  const rowHit = rowsHold(c, view, isMine, focus);
  return (
    <li className="dpp-card" id={`deploy-${lead.short_id}`} data-kind={lead.status === "requested" && !going ? "asked" : lead.status} data-live={isLive ? "" : undefined} data-quiet={quiet ? "" : undefined}
      data-focus={focused && (focus?.kind === "deploy" || !rowHit) ? "" : undefined} data-deploy-card={lead.short_id || lead._id}>
      <div className="dpp-card-head">
        <StatePill status={lead.status} live={isLive} sha={lead.sha} />
        <button type="button" className="dpp-card-title" aria-expanded={opened === lead.short_id} onClick={() => toggle(lead)} data-deploy-open={lead.short_id}>{lead.short_id || "…"}</button>
        <span className="dpp-meta">
          {lead.sha ? <code className="dpp-sha">{short(lead.sha)}</code> : null}
          <span className="dpp-by">{lead.started_by ?? sourceWord(lead)}</span>
          {lead.action !== "deploy" ? <span className="dpp-fact">{lead.action === "rollback" ? "rolled back" : "redeployed"} to {lead.rollback_of ?? short(lead.sha)}</span> : null}
          {earlier.length ? (
            <span className="dpp-fact">same commit {earlier.map((d, i) => (
              <span key={d._id}>{i ? ", " : ""}{d.status === "live" ? "went out" : d.status} earlier as <button type="button" className="dpp-attempt" aria-expanded={opened === d.short_id} onClick={() => toggle(d)} data-deploy-open={d.short_id}>{d.short_id}</button></span>
            ))}</span>
          ) : null}
          {going ? <span className="dpp-fact" data-deploy-sending>{plural(c.commits.length + c.more, "commit")}</span> : null}
          {step ? <span className="dpp-fact" data-deploy-step>{step}</span> : null}
          {lead.after?.open && lead.status !== "failed" ? <AfterMark after={lead.after} /> : null}
        </span>
        <span className="dpp-card-end">
          {back ? <button type="button" className="dpp-row-act" aria-haspopup="dialog" onClick={() => onRollback(back)} data-deploy-redeploy={wentLive.short_id}><RotateCcw className="w-3 h-3" aria-hidden />Roll back here</button>
          : here ? <button type="button" className="dpp-row-act" onClick={() => onPress(here)} data-deploy-redeploy={wentLive.short_id}><RotateCcw className="w-3 h-3" aria-hidden />Roll back here</button>
          : null}
          <span className="dpp-age" title={`${lead.live_at ? "Went live" : lead.status === "requested" && !going ? "Asked for" : "Started"} ${new Date(at).toLocaleString()}`}>{ago(now, at)}</span>
        </span>
      </div>
      {lead.status === "failed" && lead.note ? <p className="dpp-card-note">{lead.note}</p> : null}
      {openOne ? <DeployDetail d={openOne} now={now} /> : null}
      {quiet ? null
        : empty ? <p className="dpp-none">{lead.status === "live" ? (rebuiltOnly(lead) ? "Rebuilt, nothing new" : "Nothing recorded") : "Nothing recorded yet"}</p>
        : <CarriedList carried={c} view={view} mine={mine} isMine={isMine} newer={newer} self={lead.short_id} focus={focus} repository={t.repository} />}
    </li>
  );
}

/** Whether the view draws a row holding the linked thing (Branches unrecorded draws none). */
function rowsHold(c: Carried, view: BoardView, isMine: (id: string) => boolean, focus: DeployFocus | null): boolean {
  if (!focus || (view === "branches" && !c.branchesKnown)) return false;
  return rowsFor(c, view, isMine).some((r) => rowMatches(r, c, focus));
}

/** What a card carried, as the switch lists it: own rows first with a blue dot, + and − in their own columns. */
function CarriedList({ carried: c, view, mine, isMine, newer, self, focus, repository }: {
  carried: Carried; view: BoardView; mine: boolean; isMine: (id: string) => boolean; newer: ReadonlyMap<string, CardId>; self: CardId; focus: DeployFocus | null; repository: string;
}) {
  const all = rowsFor(c, view, isMine);
  const hit = (r: BoardRow) => rowMatches(r, c, focus);
  // Mine keeps the viewer's rows, and the row a link points at.
  const rows = mine ? all.filter((r) => r.mine || hit(r)) : all;
  const { shown, hidden } = fold(rows.length);
  // Folded rows open on their own while one of them is the linked thing; the viewer's press then decides.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? rows.slice(shown).some(hit);
  if (view === "branches" && !c.branchesKnown) return <p className="dpp-none">Branches aren't recorded on this deploy</p>;
  if (!rows.length) return <p className="dpp-none" data-deploy-none-mine={mine ? "" : undefined}>{mine ? "None of yours" : "Nothing recorded"}</p>;
  const counted = view !== "tasks";
  const idColumn = view === "prs" || view === "shas";
  return (
    <>
      <ul className="dpp-list" data-view={view}>
        {(open ? rows : rows.slice(0, shown)).map((r) => (
          <li key={r.key} className="dpp-row" data-id-col={idColumn ? "" : undefined} data-counted={counted ? "" : undefined} data-mine={r.mine ? "" : undefined} data-focus={hit(r) ? "" : undefined} data-deploy-row={r.key}>
            <span className="dpp-gutter">{r.mine && !mine ? <i className="dpp-you" title="Yours" aria-label="yours" /> : null}</span>
            <RowItem r={r} c={c} view={view} newer={newer} self={self} repository={repository} />
            {counted ? <Lines add={r.insertions} del={r.deletions} /> : null}
          </li>
        ))}
      </ul>
      {hidden ? <button type="button" className="dpp-more-rows" onClick={() => setToggled(!open)} data-deploy-rows-more={hidden}>{open ? "Show fewer" : `Show ${hidden} more ${VIEW_WORDS[view].rows}`}</button> : null}
      {c.more > 0 && view !== "sessions" && view !== "priorities" ? <p className="dpp-none">+{c.more} older {c.more === 1 ? "commit" : "commits"} not listed</p> : null}
    </>
  );
}

/** One row's item: the app's own pill for a session or task (whole title, wrapping as prose), an id column and subject for a PR or SHA. */
function RowItem({ r, c, view, newer, self, repository }: { r: BoardRow; c: Carried; view: BoardView; newer: ReadonlyMap<string, CardId>; self: CardId; repository: string }) {
  if (view === "sessions") {
    if (!r.session) return <span className="dpp-row-main dpp-dim">{plural(r.commits ?? 0, "commit")} not from a session</span>;
    const later = newer.get(r.session);
    // A session the viewer may not read comes without a title: the pill resolves what it may show from the id.
    const title = c.sessions.find((s) => s.id === r.session)?.title;
    return (
      <span className="dpp-row-main">
        <EntityIdPill type="session" id={r.session} label={title ? sessionWords({ conversation_id: r.session, title }) : undefined} wide />
        {later && later !== self ? <span className="dpp-newer">newer work {later === "next" ? "waiting to deploy" : `going out in ${later}`}</span> : null}
      </span>
    );
  }
  if (view === "tasks") return <span className="dpp-row-main"><EntityIdPill type="task" id={r.task!} label={r.label ?? undefined} wide /></span>;
  if (view === "branches") return <span className="dpp-row-main">{r.branch ? <span className="dpp-branch"><GitBranch aria-hidden />{r.branch}</span> : <span className="dpp-dim">Branch not recorded</span>}</span>;
  if (view === "priorities") return <span className="dpp-row-main">{r.label ?? <span className="dpp-dim">No priority</span>} <span className="dpp-dim">· {plural(r.sessions?.length ?? 0, "session")}</span></span>;
  const id = view === "prs" && r.pr
    ? <EntityIdPill type="pr" id={`${repository}#${r.pr}`} idLabel={`#${r.pr}`} certain compact bare />
    : view === "prs" ? <span className="dpp-dim">no PR</span>
    : <EntityIdPill type="commit" id={`${repository}@${r.sha!.slice(0, 10)}`} idLabel={short(r.sha)} certain compact bare />;
  return <><span className="dpp-row-id" data-deploy-pr={view === "prs" && r.pr ? r.pr : undefined}>{id}</span><span className="dpp-row-main">{r.label}</span></>;
}

/** Lines added and removed, the way GitHub prints them; "—" when nothing recorded them. */
function Lines({ add, del }: { add?: number; del?: number }) {
  if (add == null && del == null) return <span className="dpp-lines"><b className="dpp-unk">—</b><b /></span>;
  return <span className="dpp-lines"><b className="dpp-add">+{(add ?? 0).toLocaleString()}</b><b className="dpp-del">−{(del ?? 0).toLocaleString()}</b></span>;
}

/** A deploy's state, first in its card's head; Next deploy has none. */
function StatePill({ status, live, sha }: { status: TeamDeployRow["status"]; live: boolean; sha: string | null | undefined }) {
  // A deploy asked for with no commit yet carries nothing out: it is not "going out" (a stale request would say so forever).
  const [word, tone] = live ? ["Live now", "green"] : status === "running" || (status === "requested" && sha) ? ["Going out", "yellow"] : status === "requested" ? ["Asked for", "idle"] : status === "failed" ? ["Failed", "red"] : status === "cancelled" ? ["Cancelled", "idle"] : ["Deployed", "done"];
  return (
    <span className="dpp-pill" data-tone={tone} data-deploy-state={word}>
      {tone === "yellow" ? <Loader2 className="animate-spin" aria-hidden /> : tone === "green" || tone === "done" ? <Check strokeWidth={3} aria-hidden /> : tone === "red" ? <X strokeWidth={3} aria-hidden /> : null}{word}
    </span>
  );
}

/** CI on what a deploy now would send, in words beside the press. */
function HeadCi({ ci, url }: { ci: CommitCiState; url: string | null }) {
  const word = ci === "passed" ? "CI passed" : ci === "failed" ? "CI failed" : ci === "running" ? "CI running" : "No CI run";
  return url ? <a className="dpp-headci" data-ci={ci} href={url} target="_blank" rel="noreferrer" data-deploy-ci>{word}</a> : <span className="dpp-headci" data-ci={ci} data-deploy-ci>{word}</span>;
}

/** What happened after a deploy went live: quiet, or the errors that started or came back in its window. */
function AfterMark({ after }: { after: NonNullable<TeamDeployRow["after"]> }) {
  if (after.quiet) return <span className="dpp-after" data-tone="ok">quiet since</span>;
  const parts = [after.new_errors ? `${after.new_errors} new ${after.new_errors === 1 ? "error" : "errors"}` : null, after.regressions ? `${after.regressions} came back` : null].filter(Boolean);
  return parts.length ? <span className="dpp-after" data-tone="bad" title="Errors that started or came back anywhere in the workspace since this went live">since: {parts.join(" · ")}</span> : null;
}

/** One deploy whole: who sent it, its steps, what its push added and dropped, its note and its own log. */
export function DeployDetail({ d, now }: { d: TeamDeployRow; now: number }) {
  // The row counts what a push added and dropped; the names come with the deploy itself, held in deployDetails.
  useSyncDeployDetail(hasChangeNames(d) ? d.short_id : null);
  const names = useDeployDetail(d._id);
  const origin = originWords(d);
  return (
    <div className="dpp-detail" data-deploy-detail={d.short_id}>
      <dl>
        <dt>Sent</dt><dd><code>{short(d.previous_sha)}</code> → <code>{short(d.sha)}</code>{d.version && !(d.sha ?? "").startsWith(d.version.slice(0, 7)) ? <span className="dpp-ver"> {d.version}</span> : null}</dd>
        <dt>By</dt><dd>{d.started_by ?? sourceWord(d)} · {new Date(d.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{d.live_at && d.live_at - d.created_at >= 60_000 ? ` · live after ${ageShort(d.live_at - d.created_at)}` : ""}</dd>
        {origin ? <><dt>From</dt><dd data-deploy-origin>{origin}</dd></> : null}
        {changeGroups(d, names).map((g) => <DeployNames key={g.kind} g={g} />)}
        {d.note ? <><dt>Note</dt><dd>{d.note}</dd></> : null}
        {d.steps?.length ? <><dt>Steps</dt><dd><ol className="dpp-steps">{d.steps.map((s) => <li key={s.id} data-status={s.status}>{s.id}</li>)}</ol></dd></> : null}
        {!sessionsOf(d).length && d.commits ? <><dt>Sessions</dt><dd className="dpp-dim">{plural(d.commits, "commit")}, none from a session</dd></> : null}
      </dl>
      {d.url ? <a className="dpp-log" href={d.url} target="_blank" rel="noreferrer" data-deploy-log={d.short_id}>{logWord(d)}</a> : null}
      {d.short_id ? <ShareControl label="deploy" path={entityRoute("deploy", d.short_id)!} /> : null}
      <span className="dpp-age">{ago(now, d.created_at)}</span>
    </div>
  );
}

/** The names a push took off its target or put on it, the first few with the rest a press away. */
function DeployNames({ g }: { g: ChangeGroup }) {
  const [all, setAll] = useState(false);
  const { shown, more } = shownNames(g.names, all);
  return (
    <>
      <dt className="dpp-names-k" data-kind={g.kind}>{g.label}</dt>
      <dd>
        <ul className="dpp-names" data-deploy-names={g.kind}>{shown.map((x) => <li key={x}><code>{x}</code></li>)}</ul>
        {more ? <button type="button" className="dpp-names-more" onClick={() => setAll(true)} data-deploy-names-more={g.kind}>+{more} more</button> : null}
      </dd>
    </>
  );
}

/** The repository's production pause (DP17): who, when and why, the rollback that made it, what lifts it, and the
 *  migrations that rule a revert out. Lift for whoever may lift it. */
export function Paused({ p, canLift, now, onLift }: { p: DeployPauseView; canLift: boolean; now: number; onLift: () => void }) {
  const u = p.until;
  return (
    <section className="dpp-going" data-kind="paused" data-deploy-paused={p.repository}>
      <Pause className="w-3.5 h-3.5" aria-hidden />
      <b>Paused</b>
      <span className="dpp-paused-by">{p.by}</span>
      <span className="dpp-age">{ago(now, p.at)}</span>
      {canLift ? <button type="button" className="dpp-back dpp-lift" onClick={onLift} data-deploy-lift={p.repository}>Lift</button> : null}
      <dl className="dpp-pause-facts">
        <dt>Why</dt><dd data-deploy-pause-reason>{p.reason}</dd>
        {p.rollback ? <><dt>Rollback</dt><dd><EntityIdPill shortId={p.rollback} compact /></dd></> : null}
        <dt>Lifts</dt>
        <dd data-deploy-pause-lifts>
          {u ? <>{u.task ? <EntityIdPill shortId={u.task} compact /> : <span className="dpp-dim">its task</span>} {u.kind === "revert" ? "revert" : "fix forward"} green on main</> : `${p.by} or the Release Captain`}
        </dd>
        {u?.migrations.length ? (
          <>
            <dt>Migrations</dt>
            <dd className="dpp-pause-warn" role="alert" data-deploy-pause-migrations={u.migrations.length}>
              <b>No revert: fix forward</b>
              <ul>{u.migrations.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

/** Where a linked change stands in Shipping: on its way, dropped there, not read yet, or not there. */
export type FocusComing = "coming" | "parked" | "reading" | null;

/** The thing the link pointed at, and where it is on this target: waiting, live in a deploy, on its way out, or not here. */
export function FocusChip({ focus, repository, waiting, coming = null, deploys, live, onClear }: { focus: DeployFocus; repository: string; waiting: boolean; coming?: FocusComing; deploys: TeamDeployRow[]; live: TeamDeployRow | null; onClear: () => void }) {
  const d = deploys[0];
  const where = waiting ? "waiting"
    : !d && coming === "coming" ? "on its way"
    : !d && coming === "parked" ? "parked on its way"
    : !d && coming === "reading" ? "looking…"
    : !d ? "not on this target"
    : focus.kind === "deploy" ? (d._id === live?._id ? "live now" : d.status)
    : d._id === live?._id ? `live in ${d.short_id}` : d.status === "live" ? `went out in ${d.short_id}` : `${d.status} in ${d.short_id}`;
  return (
    <div className="dpp-focus" data-state={waiting || (!d && coming) ? "waiting" : d ? "deployed" : "missing"} data-deploy-focus={focusWord(focus)}>
      {/* The thing reads as its pill does anywhere: a session, task, PR, commit or deploy by its title; a branch by its name. */}
      <span className="dpp-focus-ref"><FocusRef focus={focus} repository={repository} /></span>
      <span>{where}</span>
      <button type="button" onClick={onClear} aria-label="Clear highlight" data-deploy-focus-clear><X className="w-3 h-3" aria-hidden /></button>
    </div>
  );
}

function FocusRef({ focus: f, repository }: { focus: DeployFocus; repository: string }) {
  switch (f.kind) {
    case "pr": return <EntityIdPill type="pr" id={`${repository}#${f.pr}`} label={focusWord(f)} certain wide />;
    case "sha": return <EntityIdPill type="commit" id={`${repository}@${f.sha}`} label={focusWord(f)} certain wide />;
    case "task": return <EntityIdPill type="task" id={f.id} wide />;
    case "session": return <EntityIdPill type="session" id={f.id} wide />;
    case "deploy": return <EntityIdPill type="deploy" id={f.id} wide />;
    case "branch": return <b>{f.name}</b>;
  }
}
