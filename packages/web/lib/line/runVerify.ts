// A run's own Verify figure, read off its verify step's report the way the run page reads it (runTrace scriptChecks):
// "4/4 pass". A card's Verify check says the run's figure, never a sentence of its own, so the card and the run agree
// (ct-59338: the run read "Verify 4/4 pass" while its card's Checks tile counted the card's four checks). Pure.
import { checksPassWords } from "@codecast/shared/contracts/changeCard";
import { scriptChecks } from "./scriptReport";
import { jsonObject } from "./visitOutput";

export type VerifyFigure = { text: string; bad: boolean; pass: number; of: number };

/** The newest verify step's checks in one glance; null when the run has no verify report with checks. */
export function runVerifyFigure(nodes: ReadonlyArray<{ node_id: string; result_preview?: string | null }> | null | undefined): VerifyFigure | null {
  const node = [...(nodes ?? [])].reverse().find((n) => n.node_id === "verify");
  const checks = node ? scriptChecks(jsonObject(node.result_preview), node.result_preview) : null;
  if (!checks) return null;
  const pass = checks.rows.filter((r) => r.ok).length;
  return { ...checksPassWords(checks.rows), pass, of: checks.rows.length };
}
