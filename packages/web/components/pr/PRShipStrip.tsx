// An open pull request's way to production, on its own page: the same PR · CI · Review · Merge stepper and words its
// card on the Deploys page draws (components/deploys/ShipTrack), read from its Ship run when one carries it, else from
// what GitHub says of it. Beside it the press it calls for (Ship when no run carries it, the decision a waiting run
// asks for), where it goes once merged, its shepherd, and the way to its card on the Deploys page, always there for a
// reader on the team. A merged pull request has the Production band instead (PRDeploy).
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { normalizeRepository } from "@codecast/shared/contracts";
import type { PrDeployModel } from "../../hooks/usePrDeploy";
import { useShipping } from "../../hooks/useSyncShipping";
import { isMerged, prState, prStepper, runState, stepper } from "../../lib/deploys/board";
import { deploysFocusHref } from "../../lib/deploys/focus";
import { ShipTrack } from "../deploys/ShipTrack";
import { DecisionWord } from "../deploys/ShippingColumn";
import { EntityIdPill } from "../EntityIdPill";
import { ShipControl } from "../ShipControl";
import { PRShipsTo } from "./PRDeploy";

export function PRShipStrip({ pr, model, shepherd, authed }: {
  pr: any;
  model: PrDeployModel;
  /** The shepherd control: the session that owns the pull request until it merges. */
  shepherd: ReactNode;
  authed: boolean;
}) {
  const { shipping, error } = useShipping(model.open ? model.teamId : null);
  const repo = normalizeRepository(model.repository);
  // The newest run carrying this pull request (the server keeps only runs still on their way to main): by its number,
  // else by a task it names when the run recorded no PR, as the Deploys page reads it (board openPrs).
  const tasks = new Set<string>((pr.task_ids ?? []).map(String));
  const run = (shipping?.runs ?? [])
    .filter((r) => !isMerged(r))
    .filter((r) => (r.pr ? r.pr.number === model.number && normalizeRepository(r.pr.repository || model.repository) === repo : !!r.task_id && tasks.has(String(r.task_id))))
    .sort((a, b) => b.updated_at - a.updated_at)[0] ?? null;
  if (!model.open) return null;
  const state = run ? runState(run) : prState(pr);
  const steps = run ? stepper(run) : prStepper(pr);
  const decide = run?.status === "paused" && run.gate_decision_short_id ? <DecisionWord id={run.gate_decision_short_id} word={state.word} /> : undefined;
  const deploysHref = model.teamId ? deploysFocusHref({ team: model.teamId, repository: model.repository, target: model.shipsTo?.[0]?.target.name ?? null, focus: { kind: "pr", pr: model.number } }) : null;
  const goesTo = model.declares && model.shipsTo?.length ? <PRShipsTo model={model} /> : null;
  return (
    <section className="pr-rise pr-ship mt-3" style={{ ["--d" as string]: "240ms" }} data-pr-ship={run ? "run" : "pr"} aria-label="Shipping">
      <span className="pr-ship-label text-mark uppercase tracking-wider text-sol-text-dim">Shipping</span>
      <div className="pr-ship-body">
        <div className="pr-ship-line">
          <ShipTrack steps={steps} state={state} word={decide} />
          <span className="pr-ship-act">
            {/* Only once the runs are read: a press while they load could start a second run for this PR. */}
            {authed && !run && (shipping || error || !model.teamId) ? <ShipControl target={{ kind: "pull_request", id: String(pr._id) }} size="compact" /> : null}
            {deploysHref ? (
              <Link href={deploysHref} className="pr-ship-deploys" data-pr-ship-deploys>
                Open on Deploys<ArrowUpRight className="w-3.5 h-3.5" aria-hidden />
              </Link>
            ) : null}
          </span>
        </div>
        <div className="pr-ship-meta">
          {run?.task_short_id ? <span className="pr-ship-run">Ship run for <EntityIdPill type="task" shortId={run.task_short_id} /></span> : null}
          {goesTo ? <span className="pr-ship-goes"><span className="text-sol-text-dim">Goes to</span>{goesTo}</span> : null}
          {shepherd}
        </div>
      </div>
    </section>
  );
}
