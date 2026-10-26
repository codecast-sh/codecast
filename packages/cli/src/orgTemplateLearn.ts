// The learning pass and canary verbs of `cast org template learn` (org-hire.md H12).
import type { OrgInitDeps } from "./orgInit.js";
import { request } from "./orgTemplateRun.js";

export type PassResult = { template_id: string; read: number; failed: number; filed: unknown[]; refused: Record<string, number>; remaining: number };
/**
 * The learning pass for one template (H12), Codecast's publishers only: the
 * server reads each opted-in instance, asks a model and files what passes the
 * leak check. It reads a few instances per call, so this asks again while any
 * remain and the last call got somewhere.
 */
export async function learnPass(deps: OrgInitDeps, template: string): Promise<PassResult> {
  const total: PassResult = { template_id: template, read: 0, failed: 0, filed: [], refused: {}, remaining: 0 };
  for (let round = 0; round < 12; round++) {
    const part: PassResult = await request(deps, "/cli/org/template/learn/pass", { template_id: template }, { timeoutMs: 600_000 });
    total.read += part.read; total.failed += part.failed; total.filed.push(...part.filed); total.remaining = part.remaining;
    for (const [kind, n] of Object.entries(part.refused)) total.refused[kind] = (total.refused[kind] ?? 0) + n;
    if (!part.remaining || part.read === part.failed) break;
  }
  return total;
}
export const learnStatus = (deps: OrgInitDeps, template: string) => request(deps, "/cli/org/template/learn/status", { template_id: template });
export const learnDue = (deps: OrgInitDeps) => request(deps, "/cli/org/template/learn/due", {});
export const learnRollout = (deps: OrgInitDeps, template: string) => request(deps, "/cli/org/template/learn/rollout", { template_id: template });
export const learnPromote = (deps: OrgInitDeps, template: string) => request(deps, "/cli/org/template/learn/promote", { template_id: template });
