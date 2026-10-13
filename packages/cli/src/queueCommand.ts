/**
 * `cast queue`: every queue that decides when work starts on this machine,
 * what holds each one now and what waits for it. Typecheck watchers and
 * Interactive jobs are capped by this CLI (machineCaps.ts); subagent workers
 * by the server, per session and per machine (shared/contracts/subagentFleet.ts).
 */

import { listQueue, listWatchers } from "./check.js";
import { INTERACTIVE_JOB_SLOTS_DIR } from "./interactiveJob.js";
import { listFileSlots, type SlotEntry } from "./lockFile.js";
import { machineCap } from "./machineCaps.js";
import { queueAhead, queuedLabel, type SlotRow } from "@codecast/shared/contracts";

type WorkerRow = SlotRow & { title: string | null };

export type QueueReport = {
  check: { cap: number; running: Array<{ project: string; root: string; pid: number; checking: boolean; errors?: number }>; waiting: Array<{ project: string; root: string; pid: number; at: number }> };
  interactive_jobs: { cap: number; running: SlotEntry[]; waiting: SlotEntry[] };
  workers: { device: string; rows: Array<WorkerRow & { ahead: number | null }> } | { error: string };
};

export function localQueues(): Pick<QueueReport, "check" | "interactive_jobs"> {
  const jobs = listFileSlots(INTERACTIVE_JOB_SLOTS_DIR());
  return {
    check: {
      cap: machineCap("check"),
      running: listWatchers().map((w) => ({ project: w.project, root: w.root, pid: w.pid, checking: w.inProgress, errors: w.errors })),
      waiting: listQueue().map((t) => ({ project: t.project, root: t.root, pid: t.pid, at: t.at })),
    },
    interactive_jobs: { cap: machineCap("interactive_jobs"), running: jobs.holding, waiting: jobs.waiting },
  };
}

export function withQueuePositions(rows: WorkerRow[]): Array<WorkerRow & { ahead: number | null }> {
  return rows.map((r) => ({ ...r, ahead: r.slot === "queued" ? queueAhead(r.id, rows) : null }));
}

async function serverWorkers(): Promise<QueueReport["workers"]> {
  try {
    const [{ convexClient }, { deviceId }] = await Promise.all([import("./remote/convexClient.js"), import("./remote/device.js")]);
    const cc = await convexClient({ timeoutMs: 10_000 });
    const rows = (await cc.client.query(cc.api.subagentFleet.queueStatus, { api_token: cc.token })) as WorkerRow[];
    return { device: deviceId(), rows: withQueuePositions(rows) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const ago = (at: number, now: number) => {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
};

export function renderQueueReport(r: QueueReport, now = Date.now()): string {
  const lines: string[] = [];
  const head = (name: string, running: number, cap: string, waiting: number) =>
    lines.push(`${name}  ${running}/${cap} running${waiting ? `, ${waiting} waiting` : ""}`);

  head("Typecheck watchers", r.check.running.length, String(r.check.cap), r.check.waiting.length);
  for (const w of r.check.running) lines.push(`  ${w.project} @ ${w.root}  pid ${w.pid}  ${w.checking ? "checking" : `${w.errors ?? "?"} errors`}`);
  for (const w of r.check.waiting) lines.push(`  waiting ${ago(w.at, now)}: ${w.project} @ ${w.root}  pid ${w.pid}`);

  head("Interactive jobs", r.interactive_jobs.running.length, String(r.interactive_jobs.cap), r.interactive_jobs.waiting.length);
  for (const j of r.interactive_jobs.running) lines.push(`  ${ago(j.at, now)}  pid ${j.pid}  ${j.what ?? ""}`.trimEnd());
  for (const j of r.interactive_jobs.waiting) lines.push(`  waiting ${ago(j.at, now)}: pid ${j.pid}  ${j.what ?? ""}`.trimEnd());

  if ("error" in r.workers) {
    lines.push(`Workers  unavailable: ${r.workers.error}`);
  } else {
    const device = r.workers.device;
    const here = r.workers.rows.filter((w) => w.device === device);
    const cap = here[0]?.caps.per_machine ?? r.workers.rows[0]?.caps.per_machine;
    head("Workers on this machine", here.filter((w) => w.slot === "running").length, cap === undefined ? "?" : cap === 0 ? "no limit" : String(cap), here.filter((w) => w.slot === "queued").length);
    for (const w of here.filter((w) => w.slot === "queued")) {
      lines.push(`  ${w.id.slice(0, 7)}  ${queuedLabel(w.ahead ?? 0)}, ${ago(w.at, now)}  ${w.title ?? ""}`.trimEnd());
    }
    const elsewhere = r.workers.rows.length - here.length;
    if (elsewhere) lines.push(`  (${elsewhere} more on your other machines)`);
  }

  lines.push(
    "",
    "Limits: cast config check.per_machine <n> · interactive_jobs.per_machine <n> · subagents.per_session <n> · subagents.per_machine <n>",
    "A waiting worker starts when one ends; cast kill <id> drops one from the queue.",
  );
  return lines.join("\n");
}

export async function runQueueCommand(opts: { json?: boolean }): Promise<void> {
  const report: QueueReport = { ...localQueues(), workers: await serverWorkers() };
  console.log(opts.json ? JSON.stringify(report, null, 2) : renderQueueReport(report));
}
