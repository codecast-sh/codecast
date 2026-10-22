import type { OpenTaskKind } from "@codecast/shared/contracts";

// A background Agent's id follows its launch notice; its completion is a
// task-notification under that id, like the others.
const OPEN_TASK_START_RE = /^\s*(?:Command running in background with ID: ([A-Za-z0-9_-]+)|Command did not complete within its \d+s timeout and was moved to the background \(ID: ([A-Za-z0-9_-]+)\)|Monitor started \(task ([A-Za-z0-9_-]+)|Workflow launched in background\. Task ID: ([A-Za-z0-9_-]+)|Async agent launched successfully\.[\s\S]{0,400}?\bagentId: ([A-Za-z0-9_-]+))/;
export function openTaskStart(text: string): { id: string; kind: OpenTaskKind } | undefined {
  const m = text.match(OPEN_TASK_START_RE);
  if (!m) return undefined;
  if (m[1]) return { id: m[1], kind: "background" };
  if (m[2]) return { id: m[2], kind: "promoted" };
  if (m[3]) return { id: m[3], kind: "monitor" };
  if (m[4]) return { id: m[4], kind: "workflow" };
  return { id: m[5], kind: "agent" };
}
