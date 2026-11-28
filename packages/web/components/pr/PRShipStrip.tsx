// An open pull request's way to production, on its own page: the same PR · CI · Review · Merge stepper and words its
// card on the Deploys page draws (components/deploys/ShipTrack), read from its Ship run when one carries it, else from
// what GitHub says of it. Beside it the press it calls for (Ship when no run carries it, the decision a waiting run
// asks for), where it goes once merged, its shepherd, and the way to its card on the Deploys page, always there for a
// reader on the team. A merged pull request has the Production band instead (PRDeploy).
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { normalizeRepository } from "@codecast/shared/contracts";
import { onPrHead } from "@codecast/shared/contracts/deployTargets";
import type { PrDeployModel } from "../../hooks/usePrDeploy";
import { useShipping } from "../../hooks/useSyncShipping";
import { CHANGE_STEPS, isMerged, prState, prStepper, runState, runWordTarget, stepper, stepsFor } from "../../lib/deploys/board";
import { teamWorkspaceKey } from "../../lib/workspaceScope";
import { deploysFocusHref } from "../../lib/deploys/focus";
import { ShipTrack } from "../deploys/ShipTrack";
import { RunWord } from "../deploys/ShippingColumn";
import { useSessionAsk } from "../../hooks/useJourneyViewer";
import { EntityIdPill } from "../EntityIdPill";
import { ShipControl } from "../ShipControl";
import { PRShipsTo } from "./PRDeploy";

export function PRShipStrip({ pr, model, shepherd, authed, runVerdict }: {
  pr: any;
  model: PrDeployModel;
  /** The verdict a run's reviewer gave on the PR's head (the header's Review figure), which GitHub never holds. */
  runVerdict?: string | null;
  /** The shepherd control: the session that owns the pull request until it merges. */
  shepherd: ReactNode;
  authed: boolean;
}) {
  const { shipping, live, failed } = useShipping(model.open ? teamWorkspaceKey(model.teamId) : null);
  const repo = normalizeRepository(model.repository);
  // The newest run carrying this pull request (the server keeps only runs still on their way to main): by its number,
  // else by a task it names when the run recorded no PR, as the Deploys page reads it (board openPrs).
  const tasks = new Set<string>((pr.task_ids ?? []).map(String));
  const carrier = (shipping?.runs ?? [])
    .filter((r) => !isMerged(r))
    .filter((r) => (r.pr ? r.pr.number === model.number && normalizeRepository(r.pr.repository || model.repository) === repo : !!r.task_id && tasks.has(String(r.task_id))))
    .sort((a, b) => b.updated_at - a.updated_at)[0] ?? null;
  // Judged on the head GitHub has the PR on, as the header's Review figure is: a push the run has not recorded yet
  // (Resolve conflict's force-push) leaves its verdicts on the head before.
  const run = carrier ? onPrHead(carrier, pr.head_sha) : null;
  const ask = useSessionAsk(run);
  if (!model.open) return null;
  const state = run ? runState(run, ask) : prState(pr, runVerdict);
  const steps = run ? stepper(run) : prStepper(pr, runVerdict);
  const to = run ? runWordTarget(run, ask) : null;
  const decide = to ? <RunWord to={to} word={state.word} /> : undefined;
  const deploysHref = model.teamId ? deploysFocusHref({ team: model.teamId, repository: model.repository, target: model.shipsTo?.[0]?.target.name ?? null, focus: { kind: "pr", pr: model.number } }) : null;
  const goesTo = model.declares && model.shipsTo?.length ? <PRShipsTo model={model} /> : null;
  return (
    <section className="pr-rise pr-ship mt-3" style={{ ["--d" as string]: "240ms" }} data-pr-ship={run ? "run" : "pr"} aria-label="Shipping">
      <span className="pr-ship-label text-mark uppercase tracking-wider text-sol-text-dim">Shipping</span>
      <div className="pr-ship-body">
        <div className="pr-ship-line">
          <ShipTrack track={run ? stepsFor(run) : CHANGE_STEPS} steps={steps} state={state} word={decide} />
          <span className="pr-ship-act">
            {/* Only once this window has read the runs itself: a press on a cached answer could start a second run. */}
            {authed && !run && (live || failed || !model.teamId) ? <ShipControl target={{ kind: "pull_request", id: String(pr._id) }} size="compact" /> : null}
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
