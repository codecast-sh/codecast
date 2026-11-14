/**
 * Whether an action took effect, as one of five states an agent can branch on.
 *
 *   confirmed        read back, or the window visibly changed in response
 *   unverifiable     the evidence cannot tell: web content mirrors a write it
 *                    may not apply, synthetic input can change what the tree
 *                    does not show, a window repaints on its own
 *   suspected_no_op  nothing changed, in the tree or the pixels
 *   refused          an error before anything was sent; nothing happened
 *   outcome_unknown  sent, never answered; it may have landed and was not retried
 *
 * Decided here and nowhere else, from what the helper reports.
 */

import { ComputerError } from "./errors.js";
import { pixelVerdict } from "./pixels.js";
import { diffTrees, focusChanged } from "./tree.js";
import type { ComputerActionResult } from "./types.js";

export type ActionVerdict =
  | { state: "confirmed"; why: string }
  | { state: "unverifiable"; why: string }
  | { state: "suspected_no_op"; why: string }
  | { state: "refused"; why: string }
  | { state: "outcome_unknown"; why: string };

export function actionVerdict(result: ComputerActionResult): ActionVerdict {
  const v = result.action?.verification;
  if (v?.state === "verified") return { state: "confirmed", why: `the ${v.property === "focusedText" ? "text" : v.property} reads back as written` };
  if (v?.reason === "web_content_echo") return { state: "unverifiable", why: "web content reads back a write it may not have applied" };
  if (v?.reason === "window_changed") return { state: "confirmed", why: "the target window closed" };
  if (v?.reason === "value_mismatch") return { state: "suspected_no_op", why: "the value reads back different from what was written" };
  if (result.baselineTreeText === undefined) return { state: "unverifiable", why: "the helper sent no tree from before the action" };
  const diff = diffTrees(result.baselineTreeText, result.snapshot.treeText);
  if (diff.added.length || diff.removed.length || focusChanged(diff)) return { state: "confirmed", why: "the window changed" };
  const pixels = pixelVerdict(result.pixelChange);
  if (pixels?.state === "changed") return { state: "confirmed", why: "the window's pixels changed" };
  if (pixels?.state === "repainting") return { state: "unverifiable", why: "the window repaints on its own" };
  if (pixels) return { state: "suspected_no_op", why: "neither the tree nor the pixels changed" };
  if (result.action?.path !== "accessibility") return { state: "unverifiable", why: "input like this can change what the tree does not show" };
  return { state: "suspected_no_op", why: "nothing in the tree changed" };
}

export function failedActionVerdict(error: ComputerError): ActionVerdict {
  return error.outcomeUnknown
    ? { state: "outcome_unknown", why: "it was sent and never answered" }
    : { state: "refused", why: "nothing was done" };
}

export function verdictLine(verdict: ActionVerdict): string {
  const label = verdict.state === "suspected_no_op" ? "suspected no-op" : verdict.state.replaceAll("_", " ");
  return `Verdict: ${label}, ${verdict.why}.`;
}
