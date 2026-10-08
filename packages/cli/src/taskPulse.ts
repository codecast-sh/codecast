// The task pulse: the file `cast task start` writes so a session knows which
// task and plan it is bound to (~/.codecast/task-pulse/<session>.json). Read
// by the pulse hook, `cast task context --current`, and `cast decide --task`'s
// default (docs/architecture/decisions-as-documents.md D3).
import * as fs from "fs";
import * as path from "path";
import { defaultConfigDir } from "./config/configDir.js";

export interface TaskPulse {
  task?: string;
  plan?: string;
  /** The session started the task (`recordTaskStart`), rather than filed it:
   *  only then can the compaction block say it held the task and lost it. */
  started?: boolean;
}

export function readTaskPulseFor(sessionId: string | null | undefined): TaskPulse | null {
  if (!sessionId) return null;
  try {
    const file = path.join(defaultConfigDir(), "task-pulse", `${sessionId}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

export function writeTaskPulse(sessionId: string, taskId: string, planId?: string, opts: { started?: boolean } = {}): void {
  try {
    const dir = path.join(defaultConfigDir(), "task-pulse");
    fs.mkdirSync(dir, { recursive: true });
    const data: TaskPulse = { task: taskId };
    if (planId) data.plan = planId;
    if (opts.started) data.started = true;
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(data));
  } catch {}
}

/**
 * What a start leaves behind in this shell, whatever the output mode (`cast
 * task start`, `cast task ready --claim`, with or without --json): the task
 * pulse, which the prompt reminder and the compaction block read
 * (task-graph.md TG10), and the plan binding. Resolves to the plan it bound.
 */
export async function recordTaskStart(
  sessionId: string | null,
  shortId: string,
  planId: string | undefined,
  bindPlan: (planId: string, sessionId: string) => Promise<unknown>,
): Promise<string | null> {
  if (!sessionId) return null;
  writeTaskPulse(sessionId, shortId, planId, { started: true });
  if (!planId) return null;
  try {
    await bindPlan(planId, sessionId);
    return planId;
  } catch {
    return null;
  }
}
