import fs from "node:fs";
import path from "node:path";

// A Claude Code dynamic workflow lives inside the agent process that launched
// it. Its on-disk trail is subagents/workflows/<runId>/ (a journal of
// started/result entries plus one transcript per agent) while it runs, and
// workflows/<runId>.json once it ends. The daemon mirrors that trail into
// workflow_runs; these are the pure reads and verdicts behind the mirror.

export type LiveWorkflowAgent = { agent_id: string; label?: string; phase?: string; state: "running" | "done" };

// The journal's model: started-without-result = running. A resumed run re-runs
// an unfinished agent under a NEW agent id with the same key, so the
// superseded attempt (same key, later start) is dropped rather than shown as
// running forever beside its replacement.
export function parseWorkflowJournal(text: string): LiveWorkflowAgent[] {
  const started = new Map<string, { key?: string; label?: string; phase?: string }>();
  const done = new Set<string>();
  const latestByKey = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; agentId?: string; key?: string; label?: string; phase?: string };
      if (!e.agentId) continue;
      if (e.type === "started" && !started.has(e.agentId)) {
        started.set(e.agentId, { key: e.key, label: e.label, phase: e.phase });
        if (e.key) latestByKey.set(e.key, e.agentId);
      } else if (e.type === "result") done.add(e.agentId);
    } catch {}
  }
  const agents: LiveWorkflowAgent[] = [];
  for (const [id, { key, label, phase }] of started) {
    const isDone = done.has(id);
    if (!isDone && key && latestByKey.get(key) !== id) continue;
    agents.push({ agent_id: id, label, phase, state: isDone ? "done" : "running" });
  }
  return agents;
}

// A completion snapshot speaks for the run only if nothing ran after it. Stop
// and resume keep the run id, so a resumed run starts agents (journal writes)
// after its old "killed" snapshot; that snapshot must not freeze the row.
// The margin absorbs the final journal flush that races the snapshot write.
export const SNAPSHOT_RACE_MARGIN_MS = 5_000;
export function snapshotIsCurrent(snapshotMtimeMs: number | undefined, journalMtimeMs: number): boolean {
  return snapshotMtimeMs !== undefined && journalMtimeMs <= snapshotMtimeMs + SNAPSHOT_RACE_MARGIN_MS;
}

// Whether the process that ran a workflow is gone, so the run can never end
// on its own: no completion snapshot, no notification, no wake. Decided only
// on positive evidence; anything unknown (no registry pid, no process
// snapshot) is "not gone". A host counts as gone when its pid is absent from
// the process table, or when the pid now belongs to a process born after the
// run's last activity (the session was restarted; a run cannot outlive the
// process it ran in, and a resumed run would have written since).
export const WORKFLOW_HOST_QUIET_MS = 2 * 60_000;
export function workflowHostGone(opts: {
  now: number;
  lastActivityMs: number;
  hostPid: number | undefined;
  procs: Array<{ pid: number; startedAt?: string }> | undefined;
}): boolean {
  const { now, lastActivityMs, hostPid, procs } = opts;
  if (now - lastActivityMs < WORKFLOW_HOST_QUIET_MS) return false;
  if (hostPid === undefined || !procs || procs.length === 0) return false;
  const row = procs.find((p) => p.pid === hostPid);
  if (!row) return true;
  const born = row.startedAt ? Date.parse(row.startedAt) : NaN;
  // lstart has one second resolution.
  return Number.isFinite(born) && born > lastActivityMs + 1_000;
}

// The newest write anywhere in the run's trail.
export async function workflowRunLastActivity(runDir: string): Promise<number> {
  let latest = 0;
  for (const f of await fs.promises.readdir(runDir)) {
    if (!f.endsWith(".jsonl")) continue;
    try { latest = Math.max(latest, (await fs.promises.stat(path.join(runDir, f))).mtimeMs); } catch {}
  }
  return latest;
}
