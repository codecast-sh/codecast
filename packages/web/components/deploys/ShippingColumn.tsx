"use client";
// The Deploys page's left column (doc s97bnygafm0x6p6cwn1f5bn6258jyjfa): every change not on main yet. First each
// change sent through Ship, one card per task (its newest run); then every open pull request no run carries, so a PR
// opened by hand, or one whose run ended, is never missing from the page. Each card draws its track's stepper
// (components/deploys/ShipTrack): a run's own (PR · CI · Review · Merge for a change that goes up as a pull request,
// Check · Review · Land for one that goes straight onto main), PR · CI · Review · Merge for an open pull request. Runs
// with no movement for a week fold into Quiet runs; open PRs never fold (their updated_at is restamped by every push to
// main, so it says nothing of movement). Several projects drawn together list every one's runs and pull requests, each
// card tagged with its project. Drawn from props alone (lib/deploys/board.ts).
import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { onPrHead, type ShippingRun, type ShippingShipper } from "@codecast/shared/contracts/deployTargets";
import { normalizeRepository } from "@codecast/shared/contracts";
import type { CheckoutRow } from "@codecast/shared/contracts/checkouts";
import { CHANGE_STEPS, ago, byUrgency, openPrs, prState, prStepper, repositoryOfRun, runOwner, runState, runWordTarget, shippingRuns, stepper, stepsFor, type CardId, type OpenPr } from "../../lib/deploys/board";
import { prMatches, runMatches, type DeployFocus } from "../../lib/deploys/focus";
import { EntityIdPill } from "../EntityIdPill";
import { usePullRequestRun } from "../../hooks/useSyncWorkflows";
import { useSessionAsk } from "../../hooks/useJourneyViewer";
import { reviewOnHead } from "../../lib/ship/changePage";
import { RepoTag } from "./RepoFace";
import { ShipTrack } from "./ShipTrack";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Landed = ReadonlyMap<string, ReadonlySet<number>>;

/** Every repository's unmerged runs, as shippingRuns splits one repository's, merged in its order (byUrgency). */
function runsOf(repositories: ReadonlyArray<string>, o: Omit<Parameters<typeof shippingRuns>[1], "repository" | "landedPrs"> & { landedPrs: Landed }, runs: ReadonlyArray<ShippingRun>) {
  const each = repositories.map((repository) => shippingRuns(runs, { ...o, repository, landedPrs: o.landedPrs.get(repository.toLowerCase()) }));
  if (each.length === 1) return each[0];
  return { moving: each.flatMap((x) => x.moving).sort(byUrgency), dropped: each.flatMap((x) => x.dropped).sort(byUrgency) };
}

/** Every repository's open pull requests no run carries, as openPrs reads one repository's, newest opened first. */
function prsOf(repositories: ReadonlyArray<string>, prs: ReadonlyArray<OpenPr>, o: Omit<Parameters<typeof openPrs>[1], "repository" | "landedPrs"> & { landedPrs: Landed }): OpenPr[] {
  const each = repositories.flatMap((repository) => openPrs(prs, { ...o, repository, landedPrs: o.landedPrs.get(repository.toLowerCase()) }));
  return repositories.length === 1 ? each : each.sort((a, b) => b.created_at - a.created_at);
}

export function ShippingColumn({ runs, shippers, error, prs, prsFailed = false, checkouts, repositories, tagIn, now, me, meLogin, mine, focus, onMain, landedPrs }: {
  /** The team's Ship runs on their way; null while they are read. */
  runs: ReadonlyArray<ShippingRun> | null;
  /** Who pressed Ship on each run: Mine reads that session's owner, as the deploy column does. */
  shippers: ReadonlyArray<ShippingShipper>;
  /** They could not be read. */
  error: boolean;
  /** The repositories' pull requests the store holds (open ones are drawn); null while none are read. */
  prs: ReadonlyArray<OpenPr> | null;
  /** They could not be read. */
  prsFailed?: boolean;
  /** Pull requests whose commit is on main (waiting or deployed), by repository (lowercased): their runs merged outside the flow. */
  landedPrs: Landed;
  /** The team's checkouts: a run with no pull request yet finds its repository by the one it runs in. */
  checkouts: ReadonlyArray<Pick<CheckoutRow, "path" | "repository">>;
  /** The repositories whose changes it lists: one, or every project drawn together. */
  repositories: ReadonlyArray<string>;
  /** Drawn together: the workspace whose project faces tag each card. */
  tagIn: string | null;
  now: number;
  me: string | null;
  /** The viewer's GitHub login: Mine keeps the pull requests they opened. */
  meLogin: string | null;
  mine: boolean;
  focus: DeployFocus | null;
  /** Each task's newest place on main (the deploy card holding its earlier rounds). */
  onMain: ReadonlyMap<string, CardId>;
}) {
  const all = runsOf(repositories, { checkouts, now, landedPrs }, runs ?? []);
  // Mine keeps the viewer's runs, and the run a link points at.
  const { moving, dropped } = mine ? runsOf(repositories, { checkouts, now, landedPrs, keep: (r) => (!!me && runOwner(r, shippers) === me) || runMatches(r, focus) }, runs ?? []) : all;
  // Each card's own repository: its pull request's, and drawn together, the project it is tagged with.
  const repoOf = (r: ShippingRun) => (repositories.length === 1 ? repositories[0] : repositoryOfRun(r, checkouts) ?? repositories[0]);
  // The head GitHub has the run's pull request on, which a push the run has not recorded yet moves past its own.
  const prHeadOf = (r: ShippingRun) => {
    if (!r.pr) return null;
    const repo = normalizeRepository(r.pr.repository || repoOf(r));
    return prs?.find((p) => p.number === r.pr!.number && normalizeRepository(p.repository) === repo)?.head_sha ?? null;
  };
  // A PR a run carries is that run's card, merged or not: only the runs judged above (every run of these repositories) stand for their PRs.
  const carriers = [...all.moving, ...all.dropped];
  // PR cards wait for the runs: until they are read, every PR a run carries would draw as its own card, then move.
  const runsRead = !!runs || error;
  const prsRead = !!prs || prsFailed;
  const prRows = runsRead ? prs ?? [] : [];
  const login = meLogin?.toLowerCase() ?? null;
  const allPrs = prsOf(repositories, prRows, { runs: carriers, landedPrs });
  // GitHub logins compare without case.
  const shownPrs = mine ? prsOf(repositories, prRows, { runs: carriers, landedPrs, keep: (p) => (!!login && p.author_github_username?.toLowerCase() === login) || prMatches(p, focus) }) : allPrs;
  const count = moving.length + shownPrs.length;
  const total = all.moving.length + allPrs.length;
  // Quiet opens on its own while it holds the linked run; the viewer's press then decides.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const showQuiet = toggled ?? dropped.some((r) => runMatches(r, focus));
  // The count, and "nothing", wait for both reads: until then the column cannot say what is not shipping.
  const read = runsRead && prsRead;
  return (
    <section className="dpp-sec" id="dpp-shipping" data-deploy-shipping>
      <h3 className="dpp-colhead">Shipping{read && !error && !prsFailed ? <span className="dpp-num" data-deploy-shipping-count>{mine ? `${count} of ${total}` : plural(count, "change")}</span> : null}</h3>
      <p className="dpp-sub">Ship runs and open pull requests, not on main yet</p>
      <ul className="dpp-ship">
        {moving.map((r) => <RunCard key={r._id} r={onPrHead(r, prHeadOf(r))} repository={repoOf(r)} tagIn={tagIn} now={now} focus={focus} earlier={r.task_short_id ? onMain.get(r.task_short_id) ?? null : null} />)}
        {error ? <li className="dpp-run dpp-run--none" data-deploy-shipping-error>Ship runs can't be read right now</li> : null}
        {prsFailed ? <li className="dpp-run dpp-run--none" data-deploy-prs-error>Open pull requests can't be read right now</li> : null}
        {!read ? <li className="dpp-run dpp-run--none">Reading what is shipping…</li> : null}
        {read && !error && !prsFailed && !moving.length && !shownPrs.length ? <li className="dpp-run dpp-run--none">{mine ? "None of yours" : "Nothing shipping right now"}</li> : null}
        {dropped.length ? (
          <li>
            <button type="button" className="dpp-fold" aria-expanded={showQuiet} onClick={() => setToggled(!showQuiet)} data-deploy-dropped={dropped.length}>
              <ChevronRight className="dpp-chev" aria-hidden />Quiet runs<span className="dpp-pick-n">{dropped.length}</span><span className="dpp-fold-sub">stopped, or no movement for 7+ days</span>
            </button>
          </li>
        ) : null}
        {showQuiet ? dropped.map((r) => <RunCard key={r._id} r={onPrHead(r, prHeadOf(r))} repository={repoOf(r)} tagIn={tagIn} now={now} focus={focus} earlier={null} dropped />) : null}
        {shownPrs.length ? (
          <li className="dpp-group" data-deploy-open-prs={shownPrs.length}>
            Open pull requests<span className="dpp-pick-n">{shownPrs.length}</span><span className="dpp-fold-sub">no Ship run</span>
          </li>
        ) : null}
        {shownPrs.map((p) => <PrCard key={p._id} pr={p} tagIn={tagIn} now={now} focus={focus} />)}
      </ul>
    </section>
  );
}

function RunCard({ r, repository, tagIn, now, focus, earlier, dropped = false }: {
  r: ShippingRun;
  repository: string;
  tagIn: string | null;
  now: number;
  focus: DeployFocus | null;
  earlier: CardId | null;
  dropped?: boolean;
}) {
  const ask = useSessionAsk(r);
  const state = runState(r, ask);
  const to = runWordTarget(r, ask);
  const title = r.task_title ?? r.task_short_id ?? "A change";
  return (
    <li className="dpp-run" id={`ship-${r._id}`} data-tone={state.tone} data-dropped={dropped ? "" : undefined} data-focus={runMatches(r, focus) ? "" : undefined} data-deploy-run={r._id}>
      <div className="dpp-run-top">
        {tagIn ? <RepoTag workspace={tagIn} repository={repository} /> : null}
        {r.task_short_id ? <Link className="dpp-run-title" href={`/tasks/${r.task_short_id}`}>{title}</Link> : <span className="dpp-run-title">{title}</span>}
        <span className="dpp-age">{ago(now, r.updated_at)}</span>
      </div>
      <ShipTrack track={stepsFor(r)} steps={stepper(r)} state={state} word={to ? <RunWord to={to} word={state.word} /> : undefined} />
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

/** A run's state word, opening what it waits on (board runWordTarget) when it waits on someone. */
export function RunWord({ to, word }: { to: { decision: string } | { session: string }; word: string }) {
  if ("decision" in to) return <DecisionWord id={to.decision} word={word} />;
  return <Link href={`/conversation/${to.session}`} className="dpp-decide" data-deploy-asking={to.session}>{word}</Link>;
}

/** An open pull request no run carries: its title opens its page; the stepper reads what GitHub says of it, and the
 *  review a codecast run's reviewer gave on its head, as the PR's page does (PRShipStrip). */
function PrCard({ pr, tagIn, now, focus }: { pr: OpenPr; tagIn: string | null; now: number; focus: DeployFocus | null }) {
  const run = usePullRequestRun(pr.repository, pr.number);
  const runVerdict = pr.head_sha && reviewOnHead(run, pr.head_sha) ? run?.review_verdict?.verdict ?? null : null;
  const state = prState(pr, runVerdict);
  return (
    <li className="dpp-run" id={`pr-${pr.number}`} data-tone={state.tone} data-focus={prMatches(pr, focus) ? "" : undefined} data-deploy-pr={pr.number}>
      <div className="dpp-run-top">
        {tagIn ? <RepoTag workspace={tagIn} repository={pr.repository} /> : null}
        <Link className="dpp-run-title" href={`/pr/${pr.repository}/${pr.number}`}>{pr.title}</Link>
        <span className="dpp-age" title={new Date(pr.created_at).toLocaleString()}>opened {ago(now, pr.created_at)}</span>
      </div>
      <ShipTrack track={CHANGE_STEPS} steps={prStepper(pr, runVerdict)} state={state} />
      <div className="dpp-refs">
        <EntityIdPill type="pr" id={`${pr.repository}#${pr.number}`} idLabel={`#${pr.number}`} certain compact bare />
        {pr.author_github_username ? <span className="dpp-flowname">by {pr.author_github_username}</span> : null}
      </div>
    </li>
  );
}
