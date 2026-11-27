"use client";
// The Deploys page's left column (doc s97bnygafm0x6p6cwn1f5bn6258jyjfa): every change sent through Ship and not on
// main yet, one card per task (its newest run), with the PR · CI · Review · Merge stepper and where the run stands in
// words. A run with no movement for a week folds into Dropped. Drawn from props alone (lib/deploys/board.ts).
import { useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Loader2, X } from "lucide-react";
import type { ShippingRun, ShippingShipper } from "@codecast/shared/contracts/deployTargets";
import type { CheckoutRow } from "@codecast/shared/contracts/checkouts";
import { STEPS, ago, runOwner, runState, shippingRuns, stepper, type CardId } from "../../lib/deploys/board";
import { runMatches, type DeployFocus } from "../../lib/deploys/focus";
import { EntityIdPill } from "../EntityIdPill";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ShippingColumn({ runs, shippers, error, checkouts, repository, now, me, mine, focus, onMain, landedPrs }: {
  /** The team's Ship runs on their way; null while they are read. */
  runs: ReadonlyArray<ShippingRun> | null;
  /** Who pressed Ship on each run: Mine reads that session's owner, as the deploy column does. */
  shippers: ReadonlyArray<ShippingShipper>;
  /** They could not be read. */
  error: boolean;
  /** Pull requests whose commit is on main (waiting or deployed): their runs merged outside the flow. */
  landedPrs: ReadonlySet<number>;
  /** The team's checkouts: a run with no pull request yet finds its repository by the one it runs in. */
  checkouts: ReadonlyArray<Pick<CheckoutRow, "path" | "repository">>;
  repository: string;
  now: number;
  me: string | null;
  mine: boolean;
  focus: DeployFocus | null;
  /** Each task's newest place on main (the deploy card holding its earlier rounds). */
  onMain: ReadonlyMap<string, CardId>;
}) {
  const all = shippingRuns(runs ?? [], { repository, checkouts, now, landedPrs });
  // Mine keeps the viewer's runs, and the run a link points at.
  const { moving, dropped } = mine ? shippingRuns(runs ?? [], { repository, checkouts, now, landedPrs, keep: (r) => (!!me && runOwner(r, shippers) === me) || runMatches(r, focus) }) : all;
  // Dropped opens on its own while it holds the linked run; the viewer's press then decides.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const showDropped = toggled ?? dropped.some((r) => runMatches(r, focus));
  return (
    <section className="dpp-sec" id="dpp-shipping" data-deploy-shipping>
      <h3 className="dpp-colhead">Shipping{runs ? <span className="dpp-num" data-deploy-shipping-count>{mine ? `${moving.length} of ${all.moving.length}` : plural(moving.length, "change")}</span> : null}</h3>
      <p className="dpp-sub">Sent through Ship and not on main yet</p>
      <ul className="dpp-ship">
        {moving.map((r) => <RunCard key={r._id} r={r} repository={repository} now={now} focus={focus} earlier={r.task_short_id ? onMain.get(r.task_short_id) ?? null : null} />)}
        {!moving.length ? <li className="dpp-run dpp-run--none">{error ? "What is shipping can't be read right now" : !runs ? "Reading what is shipping…" : mine ? "None of yours" : "Nothing shipping right now"}</li> : null}
        {dropped.length ? (
          <li>
            <button type="button" className="dpp-fold" aria-expanded={showDropped} onClick={() => setToggled(!showDropped)} data-deploy-dropped={dropped.length}>
              <ChevronRight className="dpp-chev" aria-hidden />Dropped<span className="dpp-pick-n">{dropped.length}</span><span className="dpp-fold-sub">no movement for 7+ days</span>
            </button>
          </li>
        ) : null}
        {showDropped ? dropped.map((r) => <RunCard key={r._id} r={r} repository={repository} now={now} focus={focus} earlier={null} dropped />) : null}
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
  const steps = stepper(r);
  const { word, tone, detail } = runState(r);
  const title = r.task_title ?? r.task_short_id ?? "A change";
  return (
    <li className="dpp-run" id={`ship-${r._id}`} data-tone={tone} data-dropped={dropped ? "" : undefined} data-focus={runMatches(r, focus) ? "" : undefined} data-deploy-run={r._id}>
      <div className="dpp-run-top">
        {r.task_short_id ? <Link className="dpp-run-title" href={`/tasks/${r.task_short_id}`}>{title}</Link> : <span className="dpp-run-title">{title}</span>}
        <span className="dpp-age">{ago(now, r.updated_at)}</span>
      </div>
      <div className="dpp-track">
        <ol className="dpp-stepper" aria-label={word}>
          {STEPS.map((s, i) => (
            <li key={s.word} className="dpp-step" data-state={steps[i]}>
              <i aria-hidden>{steps[i] === "done" ? <Check strokeWidth={3} /> : steps[i] === "failed" ? <X strokeWidth={3} /> : steps[i] === "active" ? <Loader2 className="animate-spin" /> : null}</i>{s.word}
            </li>
          ))}
        </ol>
        <span className="dpp-run-now" data-tone={tone} data-deploy-run-state>{word}</span>
        {detail ? <span className="dpp-run-detail">{detail}</span> : null}
      </div>
      <div className="dpp-refs">
        {r.spawner_conversation_id && !r.stand_in ? <EntityIdPill type="session" id={r.spawner_conversation_id} wide /> : null}
        {r.pr ? <EntityIdPill type="pr" id={`${r.pr.repository || repository}#${r.pr.number}`} idLabel={`#${r.pr.number}`} certain compact bare /> : null}
        {r.workflow_slug && r.workflow_slug !== "change" ? <span className="dpp-flowname">{r.workflow_label ?? r.workflow_slug}</span> : null}
        {earlier ? <a className="dpp-earlier" href={`#deploy-${earlier}`}>earlier rounds {earlier === "next" ? "waiting to deploy" : `in ${earlier}`}</a> : null}
      </div>
    </li>
  );
}
