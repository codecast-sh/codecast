"use client";
// The Deploys page's left column (doc s97bnygafm0x6p6cwn1f5bn6258jyjfa): every change not on main yet. First each
// change sent through Ship, one card per task (its newest run); then every open pull request no run carries, so a PR
// opened by hand, or one whose run ended, is never missing from the page. Each card draws the same PR · CI · Review ·
// Merge stepper (components/deploys/ShipTrack). Runs with no movement for a week fold into Quiet runs; open PRs never
// fold (their updated_at is restamped by every push to main, so it says nothing of movement). Drawn from props alone
// (lib/deploys/board.ts).
import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ShippingRun, ShippingShipper } from "@codecast/shared/contracts/deployTargets";
import type { CheckoutRow } from "@codecast/shared/contracts/checkouts";
import { ago, openPrs, prState, prStepper, runOwner, runState, shippingRuns, stepper, type CardId, type OpenPr } from "../../lib/deploys/board";
import { prMatches, runMatches, type DeployFocus } from "../../lib/deploys/focus";
import { EntityIdPill } from "../EntityIdPill";
import { ShipTrack } from "./ShipTrack";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ShippingColumn({ runs, shippers, error, prs, checkouts, repository, now, me, meLogin, mine, focus, onMain, landedPrs }: {
  /** The team's Ship runs on their way; null while they are read. */
  runs: ReadonlyArray<ShippingRun> | null;
  /** Who pressed Ship on each run: Mine reads that session's owner, as the deploy column does. */
  shippers: ReadonlyArray<ShippingShipper>;
  /** They could not be read. */
  error: boolean;
  /** The repository's pull requests the store holds (open ones are drawn); null while none are read. */
  prs: ReadonlyArray<OpenPr> | null;
  /** Pull requests whose commit is on main (waiting or deployed): their runs merged outside the flow. */
  landedPrs: ReadonlySet<number>;
  /** The team's checkouts: a run with no pull request yet finds its repository by the one it runs in. */
  checkouts: ReadonlyArray<Pick<CheckoutRow, "path" | "repository">>;
  repository: string;
  now: number;
  me: string | null;
  /** The viewer's GitHub login: Mine keeps the pull requests they opened. */
  meLogin: string | null;
  mine: boolean;
  focus: DeployFocus | null;
  /** Each task's newest place on main (the deploy card holding its earlier rounds). */
  onMain: ReadonlyMap<string, CardId>;
}) {
  const all = shippingRuns(runs ?? [], { repository, checkouts, now, landedPrs });
  // Mine keeps the viewer's runs, and the run a link points at.
  const { moving, dropped } = mine ? shippingRuns(runs ?? [], { repository, checkouts, now, landedPrs, keep: (r) => (!!me && runOwner(r, shippers) === me) || runMatches(r, focus) }) : all;
  // A PR a run carries is that run's card, merged or not: only the runs judged above (every run of this repository) stand for their PRs.
  const carriers = [...all.moving, ...all.dropped];
  // PR cards wait for the runs: until they are read, every PR a run carries would draw as its own card, then move.
  const runsRead = !!runs || error;
  const prsRead = !!prs || prsFailed;
  const prRows = runsRead ? prs ?? [] : [];
  const login = meLogin?.toLowerCase() ?? null;
  const allPrs = openPrs(prRows, { repository, runs: carriers, landedPrs });
  // GitHub logins compare without case.
  const shownPrs = mine ? openPrs(prRows, { repository, runs: carriers, landedPrs, keep: (p) => (!!login && p.author_github_username?.toLowerCase() === login) || prMatches(p, focus) }) : allPrs;
  const count = moving.length + shownPrs.length;
  const total = all.moving.length + allPrs.length;
  // Quiet opens on its own while it holds the linked run; the viewer's press then decides.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const showQuiet = toggled ?? dropped.some((r) => runMatches(r, focus));
  // The count, and "nothing", wait for both reads: until then the column cannot say what is not shipping.
  const read = runsRead && prsRead;
  return (
    <section className="dpp-sec" id="dpp-shipping" data-deploy-shipping>
      <h3 className="dpp-colhead">Shipping{read ? <span className="dpp-num" data-deploy-shipping-count>{mine ? `${count} of ${total}` : plural(count, "change")}</span> : null}</h3>
      <p className="dpp-sub">Ship runs and open pull requests, not on main yet</p>
      <ul className="dpp-ship">
        {moving.map((r) => <RunCard key={r._id} r={r} repository={repository} now={now} focus={focus} earlier={r.task_short_id ? onMain.get(r.task_short_id) ?? null : null} />)}
        {error ? <li className="dpp-run dpp-run--none" data-deploy-shipping-error>Ship runs can't be read right now</li> : !runs ? <li className="dpp-run dpp-run--none">Reading what is shipping…</li> : !moving.length && !shownPrs.length ? <li className="dpp-run dpp-run--none">{mine ? "None of yours" : "Nothing shipping right now"}</li> : null}
        {dropped.length ? (
          <li>
            <button type="button" className="dpp-fold" aria-expanded={showQuiet} onClick={() => setToggled(!showQuiet)} data-deploy-dropped={dropped.length}>
              <ChevronRight className="dpp-chev" aria-hidden />Quiet runs<span className="dpp-pick-n">{dropped.length}</span><span className="dpp-fold-sub">no movement for 7+ days</span>
            </button>
          </li>
        ) : null}
        {showQuiet ? dropped.map((r) => <RunCard key={r._id} r={r} repository={repository} now={now} focus={focus} earlier={null} dropped />) : null}
        {shownPrs.length ? (
          <li className="dpp-group" data-deploy-open-prs={shownPrs.length}>
            Open pull requests<span className="dpp-pick-n">{shownPrs.length}</span><span className="dpp-fold-sub">no Ship run</span>
          </li>
        ) : null}
        {shownPrs.map((p) => <PrCard key={p._id} pr={p} now={now} focus={focus} />)}
      </ul>
    </section>
  );
}

function RunCard({ r, repository, now, focus, earlier, dropped = false }: {
  r: ShippingRun;
  repository: string;
  now: number;
  focus: DeployFocus | null;
  earlier: CardId | null;
  dropped?: boolean;
}) {
  const state = runState(r);
  const title = r.task_title ?? r.task_short_id ?? "A change";
  return (
    <li className="dpp-run" id={`ship-${r._id}`} data-tone={state.tone} data-dropped={dropped ? "" : undefined} data-focus={runMatches(r, focus) ? "" : undefined} data-deploy-run={r._id}>
      <div className="dpp-run-top">
        {r.task_short_id ? <Link className="dpp-run-title" href={`/tasks/${r.task_short_id}`}>{title}</Link> : <span className="dpp-run-title">{title}</span>}
        <span className="dpp-age">{ago(now, r.updated_at)}</span>
      </div>
      <ShipTrack steps={stepper(r)} state={state} word={r.status === "paused" && r.gate_decision_short_id ? <DecisionWord id={r.gate_decision_short_id} word={state.word} /> : undefined} />
      <div className="dpp-refs">
        {r.spawner_conversation_id && !r.stand_in ? <EntityIdPill type="session" id={r.spawner_conversation_id} wide /> : null}
        {r.pr ? <EntityIdPill type="pr" id={`${r.pr.repository || repository}#${r.pr.number}`} idLabel={`#${r.pr.number}`} certain compact bare /> : null}
        {r.workflow_slug && r.workflow_slug !== "change" ? <span className="dpp-flowname">{r.workflow_label ?? r.workflow_slug}</span> : null}
        {earlier ? <a className="dpp-earlier" href={`#deploy-${earlier}`}>earlier rounds {earlier === "next" ? "waiting to deploy" : `in ${earlier}`}</a> : null}
      </div>
    </li>
  );
}

/** A run waiting on a decision: its words open the decision, where the person answers it. */
export function DecisionWord({ id, word }: { id: string; word: string }) {
  return <Link href={`/decisions/${id}`} className="dpp-decide" data-deploy-decision={id}>{word}</Link>;
}

/** An open pull request no run carries: its title opens its page; the stepper reads what GitHub says of it. */
function PrCard({ pr, now, focus }: { pr: OpenPr; now: number; focus: DeployFocus | null }) {
  const state = prState(pr);
  return (
    <li className="dpp-run" id={`pr-${pr.number}`} data-tone={state.tone} data-focus={prMatches(pr, focus) ? "" : undefined} data-deploy-pr={pr.number}>
      <div className="dpp-run-top">
        <Link className="dpp-run-title" href={`/pr/${pr.repository}/${pr.number}`}>{pr.title}</Link>
        <span className="dpp-age" title={new Date(pr.created_at).toLocaleString()}>opened {ago(now, pr.created_at)}</span>
      </div>
      <ShipTrack steps={prStepper(pr)} state={state} />
      <div className="dpp-refs">
        <EntityIdPill type="pr" id={`${pr.repository}#${pr.number}`} idLabel={`#${pr.number}`} certain compact bare />
        {pr.author_github_username ? <span className="dpp-flowname">by {pr.author_github_username}</span> : null}
      </div>
    </li>
  );
}
