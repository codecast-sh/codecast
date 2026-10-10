"use client";
// Save and the step's versions (line-workspace.md LW4). Save writes the edit
// to the file the graph names, in the checkout that pushed it, through that
// machine's daemon (store editLineGraph). Its state is the newest save row
// for the step in the store (sessionCommands), so it survives the drawer
// closing and a refusal still shows when the edit comes back. Versions list
// every text the step has had: each save is one, and the runs say which
// text they read.
import { useMemo } from "react";
import type { LineModel, LineStep } from "../../../../lib/line/lineModel";
import { drawnWorkflowId, saveState } from "../../../../lib/line/lineActions";
import { newRequestId } from "../../../../lib/sessionCommands";
import { useInboxStore } from "../../../../store/inboxStore";
import { useGraphEditability, useGraphVersions } from "../../../../hooks/useLineActions";
import { dayWords } from "../parts";
import "./actions.css";

export type SaveSlotProps = { model: LineModel; step: LineStep; draft: string };
export type VersionsSlotProps = { model: LineModel; step: LineStep };

/** The newest save of one step, from the store's sessionCommands rows. */
function useLastSave(workflowId: string | null, nodeId: string) {
  return useInboxStore((s) => {
    let best: any = null;
    const rows = (s as any).sessionCommands as Record<string, any> | undefined;
    for (const id in rows ?? {}) {
      const r = rows![id];
      if (r?.kind === "line_graph_edit" && r.workflow_id === workflowId && r.node === nodeId && (!best || (r.requested_at ?? 0) > (best.requested_at ?? 0))) best = r;
    }
    return best;
  });
}

export function SaveControl({ model, step, draft }: SaveSlotProps) {
  const workflowId = drawnWorkflowId(model);
  const can = useGraphEditability(workflowId);
  const last = useLastSave(workflowId, step.id);
  const state = saveState(last);
  // A save for this very text that is still travelling holds the button.
  const busy = !!last && last.text === draft && (state?.kind === "saving" || state?.kind === "pushing");
  if (!workflowId || can === undefined) return null;
  if (!can || !can.editable) {
    return <span className="lw-save-note" title={can?.reason}>Saved only where it was pushed from</span>;
  }
  // The text the edit was made from: the machine's own push when it is the graph drawn, else
  // the text the runs read, so a checkout that has moved since refuses the save rather than lose its change.
  const base = can.target === workflowId ? can.nodes.find((n) => n.id === step.id)?.h ?? null : step.prompt?.version?.hash ?? null;
  const save = () => {
    void useInboxStore.getState().editLineGraph(newRequestId(), workflowId, { node: step.id, field: step.prompt?.kind ?? "prompt", text: draft, base_hash: base }).catch(() => {});
  };
  return (
    <>
      {state?.kind === "refused" && last?.text === draft && <span className="lw-save-note" data-tone="bad" title={state.reason}>{state.reason}</span>}
      <button type="button" className="lw-act" data-primary="" onClick={save} disabled={busy} title={`Writes ${can.files.find((f) => f.node === step.id)?.[step.prompt?.kind ?? "prompt"] ?? can.file} on the machine that pushed it`}>
        {busy ? <><span className="lw-spin" aria-hidden /> Saving</> : "Save"}
      </button>
    </>
  );
}

/**
 * Every text the step has had, newest first: each pushed version where its
 * hash changed, and how many runs read each. The newest save's state leads
 * while it is still travelling or was refused.
 */
export function StepVersions({ model, step }: VersionsSlotProps) {
  const workflowId = drawnWorkflowId(model);
  const versions = useGraphVersions(workflowId);
  const last = useLastSave(workflowId, step.id);
  const state = saveState(last);
  const rows = useMemo(() => {
    // Each version of this step: the pushes where its hash moved.
    const out: Array<{ hash: string; at: number }> = [];
    for (const v of [...versions].reverse()) {
      const h = v.nodes.find((n) => n.id === step.id)?.h;
      if (!h || out[out.length - 1]?.hash === h) continue;
      out.push({ hash: h, at: v.at });
    }
    return out.reverse();
  }, [versions, step.id]);
  const current = step.prompt?.version ?? null;
  if (!rows.length && !state) return null;
  return (
    <div className="lw-versions" data-line-versions={step.id}>
      <div className="lw-versions-head">Versions</div>
      {state && state.kind !== "unchanged" && (
        <div className="lw-version" data-state={state.kind}>
          <span className="lw-version-hash">{state.kind === "saved" || state.kind === "pushing" ? (state.hash ?? "").slice(0, 6) : "…"}</span>
          <span>
            {state.kind === "saving" && <><span className="lw-spin" aria-hidden /> Writing the file on the machine that pushed it</>}
            {state.kind === "pushing" && <>Written to the file; updating codecast's copy</>}
            {state.kind === "saved" && <>Saved {state.at ? dayWords(state.at) : ""}</>}
            {state.kind === "refused" && <>Not saved: {state.reason}</>}
          </span>
        </div>
      )}
      {rows.map((r, i) => {
        const read = current?.hash === r.hash;
        return (
          <div key={`${r.hash}:${r.at}`} className="lw-version" data-current={i === 0 ? "" : undefined}>
            <span className="lw-version-hash">{r.hash.slice(0, 6)}</span>
            <span>
              {i === 0 ? "Now" : "Before"}, pushed {dayWords(r.at)}
              {read ? ` · ${current!.runs} ${current!.runs === 1 ? "run has" : "runs have"} read it` : i === 0 ? " · no run has read it yet" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
