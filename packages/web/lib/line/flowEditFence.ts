// An edit object read out of where it travels (docs/architecture/pipeline.md PL5): a ```flow {"edit": ...} fence body,
// or what `cast flow edit` printed (the fence, with its diff above it, or `--json`). A leaf: the fence reader
// (flowFence) and the tool card import it without the drawing's model (flowEditCard), whose imports reach lineModel.
import type { FlowEdit } from "@codecast/shared/contracts/flowEdit";
import { stripAnsi } from "./flowCommandOutput";

/** The edit a `cast flow edit` printed, and the diff it printed above it (`--json` carries both as fields). */
export function editFromOutput(output: string): { edit: FlowEdit; diff: string | null } | null {
  const text = stripAnsi(output);
  const fence = text.match(/```flow\s*\n(\{[^\n]*\})\s*\n```/);
  if (fence) {
    const edit = readEdit(fence[1]);
    const diff = text.slice(0, fence.index).match(/^--- a\/[\s\S]*$/m)?.[0]?.trim() ?? null;
    return edit ? { edit, diff } : null;
  }
  try {
    const o = JSON.parse(text.trim());
    const edit = asEdit(o);
    return edit ? { edit, diff: typeof o.diff === "string" && o.diff.trim() ? o.diff.trim() : null } : null;
  } catch {
    return null;
  }
}

/** A fence body (`{"edit": {...}}`) as an edit, or null. */
export function readEdit(code: string): FlowEdit | null {
  try {
    return asEdit(JSON.parse(code)?.edit);
  } catch {
    return null;
  }
}

/** An edit object, when it has the shape one is: a flow, a file and a list of changes. */
export function asEdit(o: unknown): FlowEdit | null {
  const e = o as FlowEdit | null;
  return e && typeof e === "object" && typeof e.flow === "string" && typeof e.file === "string" && Array.isArray(e.changes) ? e : null;
}
