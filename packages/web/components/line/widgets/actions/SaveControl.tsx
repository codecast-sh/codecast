"use client";
// Save and the step's versions (line-workspace.md LW4). Save writes the edit
// to the file the graph names, in the checkout that pushed it, through that
// machine's daemon (store editLineGraph). Its state is the newest save row
// for the step in the store (sessionCommands), so it survives the drawer
// closing and a refusal still shows when the edit comes back. Versions list
// every text the step has had: each save is one, and the runs say which
// text they read.
import { useMemo } from "react";
import { tallyDecisions, type LineModel, type LineStep } from "../../../../lib/line/lineModel";
import { drawnWorkflowId, saveState } from "../../../../lib/line/lineActions";
import { newRequestId } from "../../../../lib/sessionCommands";
import { useInboxStore } from "../../../../store/inboxStore";
import { useGraphEditability, useGraphVersions } from "../../../../hooks/useLineActions";
import { dayWords, outcomeTone } from "../parts";
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
  if (!workflowId) return null;
  // Still reading where the line is saved: the button waits, it never reads as refused.
  if (can === undefined) return <button type="button" className="lw-act" data-primary="" disabled aria-busy data-line-save="pending"><span className="lw-spin" aria-hidden /> Save</button>;
  // Saved on another machine: the page says so and offers the ask instead (StepInstructions).
  if (!can || !can.editable) return null;
  // What the edit was made from: the drawn step's text, so a checkout holding other text refuses the
  // save rather than lose its change; and, when the drawn graph is this machine's own push, its hash.
  const base = can.target === workflowId ? can.nodes.find((n) => n.id === step.id)?.h ?? null : null;
  const save = () => {
    void useInboxStore.getState().editLineGraph(newRequestId(), workflowId, { node: step.id, field: step.prompt?.kind ?? "prompt", text: draft, base_hash: base, base_text: step.prompt?.text ?? null }).catch(() => {});
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
    // Each text of this step: where a push moved its hash, and every text a run read (runs counted per hash, so the
    // counts add up to the step's runs), newest first. The newest push is the text the graph holds now.
    const pushed: Array<{ hash: string; at: number }> = [];
    for (const v of [...versions].reverse()) {
      const h = v.nodes.find((n) => n.id === step.id)?.h;
      if (!h || pushed[pushed.length - 1]?.hash === h) continue;
      pushed.push({ hash: h, at: v.at });
    }
    const out = new Map<string, { hash: string; at: number; runs: number; pushedAt: number | null; runIds: string[] }>();
    for (const r of step.prompt?.versions ?? []) {
      const was = out.get(r.hash);
      out.set(r.hash, { hash: r.hash, at: Math.min(was?.at ?? r.since, r.since), runs: (was?.runs ?? 0) + r.runs, pushedAt: null, runIds: [...(was?.runIds ?? []), ...r.runIds] });
    }
    for (const p of pushed) {
      const was = out.get(p.hash);
      out.set(p.hash, { hash: p.hash, at: was ? Math.min(was.at, p.at) : p.at, runs: was?.runs ?? 0, pushedAt: p.at, runIds: was?.runIds ?? [] });
    }
    const current = pushed[pushed.length - 1]?.hash ?? step.prompt?.versions[0]?.hash ?? null;
    // What each text decided, and how many of its closes came back: whether an edit helped, read beside the one before it.
    return [...out.values()].sort((a, b) => (a.hash === current ? -1 : b.hash === current ? 1 : b.at - a.at)).map((r) => {
      const ids = new Set(r.runIds);
      const mine = step.decisions.filter((d) => ids.has(d.runId));
      return { ...r, current: r.hash === current, tally: tallyDecisions(mine), back: mine.filter((d) => d.closed && !d.closed.held).length };
    });
  }, [versions, step.id, step.prompt?.versions, step.decisions]);
  if (!rows.length && !state) return null;
  return (
    <div className="lw-versions" data-line-versions={step.id}>
      <div className="lw-versions-head">Versions <span className="lw-num">{rows.length}</span></div>
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
      {rows.map((r) => (
        <div key={r.hash} className="lw-version" data-current={r.current ? "" : undefined}>
          <span className="lw-version-hash">{r.hash.slice(0, 6)}</span>
          <span className="lw-version-when">{r.current ? "current" : ""}{r.current ? " · " : ""}{r.pushedAt ? `pushed ${dayWords(r.pushedAt)}` : `since ${dayWords(r.at)}`}</span>
          {r.tally.total > 0 && (
            <span className="lw-vbar" aria-label={r.tally.rows.map((x) => `${x.key} ${x.n}`).join(", ")} title={r.tally.rows.map((x) => `${x.key} ${x.n}`).join("\n")}>
              {r.tally.rows.map((x) => <i key={x.key} data-tone={outcomeTone(x.key)} style={{ flex: x.n }} />)}
            </span>
          )}
          {r.back > 0 && <span className="lw-version-back lw-num" title={`${r.back} of its closes came back`}>↺{r.back}</span>}
          <span className="lw-version-runs lw-num">{r.runs ? `${r.runs} ${r.runs === 1 ? "run" : "runs"}` : "no runs"}</span>
        </div>
      ))}
    </div>
  );
}
