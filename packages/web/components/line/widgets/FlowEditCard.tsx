"use client";
// An edit to a project's flow, drawn where it was made (docs/architecture/pipeline.md
// PL5): what changed in words, the flow it builds with those stations marked
// (a skipped one a ghost where it stood), the file's diff folded under it,
// and how far it has got: not shipped yet, then the session's change run that
// carries it, live, and finally Live in its deploy. The model is
// lib/line/flowEditCard.ts; the phone draws the same one.
import { memo, useContext, useMemo, useState } from "react";
import Link from "next/link";
import { entityRoute } from "@codecast/shared/entities";
import type { FlowEdit } from "@codecast/shared/contracts/flowEdit";
import { FlowDiagram } from "./FlowDiagram";
import { InlineDiff } from "../../InlineDiff";
import { JourneyView } from "../../ship/Journey";
import { useNamedFlow, useRunFlow } from "../../../hooks/useFlowObject";
import { useSessionFlowRuns } from "../../../hooks/useSyncWorkflows";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useInboxStore } from "../../../store/inboxStore";
import { MessageIdentity } from "../../../lib/conversationBlockContexts";
import { asGitDiff, editDrawing, editLines, editRun, liveDeploy } from "../../../lib/line/flowEditCard";
import { pipelineHref, repoName } from "../../../lib/line/pipelineModel";
import { journeyOf } from "../../../lib/ship/journey";
import { runShip, shipHref, type SessionShip } from "../../../lib/ship/sessionShip";
import "../workspace/workspace.css";
import "./flowEdit.css";

/** When the message (or the tool call) that made the edit was written, read once: it never changes. */
function useMadeAt(conversationId: string | null, ref: string | null): number | null {
  return useMemo(() => {
    if (!conversationId || !ref) return null;
    const rows = (useInboxStore.getState().messages?.[conversationId] ?? []) as Array<{ _id?: string; timestamp?: number; tool_calls?: Array<{ id: string }> }>;
    const m = rows.find((r) => r._id === ref || r.tool_calls?.some((t) => t.id === ref));
    return m?.timestamp ?? null;
  }, [conversationId, ref]);
}

/** `madeBy`: the tool call that printed the edit, when it is a `cast flow edit` card; else the message the fence is in.
 *  `dryRun`: `--dry-run` wrote nothing, so nothing ships; the card is the preview. */
/** Where a shipped edit stands: Live opens its deploy, and a word about a landed commit opens the Deploys page at it. */
function FlowEditState({ live, dp, ship }: { live: boolean; dp: string | null; ship: SessionShip | null }) {
  const tone = live ? "passed" : ship?.tone === "bad" ? "failed" : ship?.tone === "you" || ship?.tone === "wait" ? "waiting" : undefined;
  const words = live ? `Live${dp ? ` · ${dp}` : ""}` : ship?.words ?? "Shipping";
  const href = live ? (dp ? entityRoute("deploy", dp) : null) : ship ? shipHref(ship) : null;
  return href
    ? <Link className="lw-flow-state no-underline hover:underline" data-tone={tone} href={href} title="Open on the Deploys page">{words}</Link>
    : <span className="lw-flow-state" data-tone={tone}>{words}</span>;
}

export const FlowEditCard = memo(function FlowEditCard({ edit, diff = null, conversationId: convProp, madeBy = null, dryRun = false }: { edit: FlowEdit; diff?: string | null; conversationId?: string | null; madeBy?: string | null; dryRun?: boolean }) {
  const identity = useContext(MessageIdentity);
  const conversationId = convProp ?? identity?.conversationId ?? null;
  const madeAt = useMadeAt(conversationId, madeBy ?? identity?.messageId ?? null);
  const runs = useSessionFlowRuns(conversationId);
  const run = useMemo(() => (dryRun ? null : editRun(edit, runs ?? [], madeAt)), [edit, runs, madeAt, dryRun]);
  const { flow: runFlow } = useRunFlow(run);
  const journey = useMemo(() => (run && runFlow ? journeyOf(runFlow, run) : null), [run, runFlow]);
  const live = journey?.now.kind === "live";
  // An older fence carries no graph: it draws over the library's backbone.
  const { flow: base } = useNamedFlow(edit.graph ? null : edit.base);
  const drawing = useMemo(() => editDrawing(edit, { base: base ?? null, live }), [edit, base, live]);
  const lines = useMemo(() => editLines(edit), [edit]);
  const now = useCoarseNow(15_000);
  const [fileOpen, setFileOpen] = useState(false);
  const ship = run ? runShip(run) : null;
  const dp = journey && "line" in journey.now ? liveDeploy(journey.now.line) : null;
  return (
    <div className="lw-widget lw-flow fe" data-flow-edit={edit.flow} data-fe-state={run ? (live ? "live" : "running") : "draft"}>
      <div className="lw-flow-head">
        <span className="lw-flow-kind" data-kind="line">Pipeline edit</span>
        <span className="lw-flow-name">{drawing?.flow.label ?? edit.flow}</span>
        {edit.repository ? <Link className="fe-repo" href={pipelineHref(edit.repository)} title={`${edit.repository}: open its pipeline`}>{repoName(edit.repository)}</Link> : null}
        <span className="fe-grow" />
        {run ? (
          <FlowEditState live={live} dp={dp} ship={ship} />
        ) : (
          <span className="lw-flow-state fe-draft">{dryRun ? "Dry run" : "Not shipped"}</span>
        )}
      </div>
      <ul className="fe-lines">
        {lines.map((l, i) => <li key={i} className="fe-line" data-op={l.startsWith("+ ") ? "add" : l.startsWith("~ ") ? "change" : l.startsWith("- ") ? "remove" : /skipped$/.test(l) ? "skip" : "other"}>{l.replace(/^[+~-] /, "")}</li>)}
      </ul>
      {drawing ? (
        <div className="fe-flow">
          <FlowDiagram flow={drawing.flow} diagram={drawing.diagram} marks={drawing.marks} quietRoutes />
        </div>
      ) : null}
      <div className="fe-foot">
        {diff ? (
          <button type="button" className="fe-file" aria-expanded={fileOpen} onClick={() => setFileOpen((o) => !o)} data-fe-file>
            <span className="fe-caret" aria-hidden>{fileOpen ? "▾" : "▸"}</span>file<span className="fe-path">{edit.file}</span>
          </button>
        ) : (
          <span className="fe-file" data-static>file<span className="fe-path">{edit.file}</span></span>
        )}
        {!run && !dryRun ? <span className="fe-when">ships when this session runs its change</span> : null}
      </div>
      {fileOpen && diff ? <div className="fe-diff"><InlineDiff raw={asGitDiff(diff)} /></div> : null}
      {run && journey ? <div className="fe-run"><JourneyView journey={journey} run={run} now_ms={now} compact /></div> : null}
    </div>
  );
});
