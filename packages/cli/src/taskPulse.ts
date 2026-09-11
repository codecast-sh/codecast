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
