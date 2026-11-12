/**
 * Workspace trust as a person's click. An agent-driven acquire that meets
 * code nobody approved posts an approval card in its conversation (a
 * `cast decide --run "ws trust"` permission ask carrying the exact text as a
 * RunSubject) and stops. The person's Yes, confirmed in the app, has the
 * daemon run `cast ws trust` in the repo as theirs, with APPROVED_RUN_ENV set
 * to the decision. That run reads the approved subject back from the server
 * (sessionDecisions.approvedRun answers only for a run a signed-in owner's
 * Yes started) and records only the targets whose text is exactly what the
 * card showed. An agent typing `cast ws trust` gets the card, never the record.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { APPROVED_RUN_ENV, RUN_OPTIONS, type RunSubject } from "@codecast/shared/contracts/commandRun";
import { sessionIdFromEnv } from "../sessionIdentity.js";
import { collectTrustTargets, recordTrust, reviewRepoTrust, type TrustFinding } from "./trust.js";

/** What the card's Yes runs, in the repo's folder. */
export const TRUST_RUN = "ws trust";

/** The card's content: every untrusted target, its exact lines, and why it is asked. */
export function trustSubject(repoRoot: string, findings: TrustFinding[]): RunSubject {
  return {
    title: "Workspace setup",
    folder: realRoot(repoRoot),
    items: findings.map(({ target, verdict, previous }) => ({
      label: target.id,
      lines: target.text.split("\n"),
      note: verdict === "new" ? "new" : `changed since ${previous?.trustedAt.slice(0, 10) ?? "approval"}`,
    })),
  };
}

export function trustQuestion(repoRoot: string): string {
  return `Allow the workspace setup in ${path.basename(realRoot(repoRoot))} to run?`;
}

function realRoot(repoRoot: string): string {
  try {
    return fs.realpathSync(repoRoot);
  } catch {
    return path.resolve(repoRoot);
  }
}

/** The server connection; tests pass a fake. */
export type TrustConnect = () => Promise<{ client: any; token: string; api: any }>;

async function client() {
  const { convexClient } = await import("../remote/convexClient.js");
  return convexClient({ timeoutMs: 20_000 });
}

/**
 * Post (or refresh) the approval card for this repo's untrusted targets in the
 * calling agent's session. Re-asking lands on the same open card: the question
 * is the same for the same repo, so a retry never stacks a second one.
 */
export async function askTrustApproval(
  repoRoot: string,
  findings: TrustFinding[],
  env: NodeJS.ProcessEnv = process.env,
  connect: TrustConnect = client,
): Promise<{ short_id?: string } | { error: string }> {
  const sessionId = sessionIdFromEnv(env);
  if (!sessionId) return { error: "no session to ask in" };
  try {
    const { client: c, token, api } = await connect();
    const result = await c.mutation(api.sessionDecisions.ask, {
      api_token: token,
      session_id: sessionId,
      question: trustQuestion(repoRoot),
      options: RUN_OPTIONS.map((o) => ({ ...o })),
      run: TRUST_RUN,
      approves: trustSubject(repoRoot, findings),
      blocking: true,
    });
    if (result?.error) return { error: String(result.error) };
    return { short_id: result?.short_id };
  } catch (err) {
    return { error: (err as Error).message.split("\n")[0] };
  }
}

/** The line an agent reads after the refusal: what was posted and what to do now. */
export function agentTrustLine(posted: { short_id?: string } | { error: string }, repoRoot: string): string {
  if ("error" in posted) {
    return `This acquire is agent driven, so it cannot approve them, and the approval card could not be posted (${posted.error}). From your codecast session run \`cast ws trust\` in ${repoRoot}: it posts the card for your person. Never ask them to type a command.`;
  }
  const card = posted.short_id ? `Approval card ${posted.short_id}` : "An approval card";
  return `${card} is posted in your conversation for your person. End your turn; when the answer says the setup was approved, run this again. Never ask them to type a command.`;
}

/**
 * `cast ws trust` run from a card's Yes: record exactly what the card showed.
 * Returns what was approved and what was not (changed on disk after the card
 * was shown, or not on the card); throws when the decision is not a live,
 * approved trust run for this repo.
 */
export async function recordApprovedTrust(
  repoRoot: string,
  decisionId: string,
  connect: TrustConnect = client,
): Promise<{ approved: string[]; unseen: string[] }> {
  const { client: c, token, api } = await connect();
  const run: { argv: string[]; cwd?: string; approves?: RunSubject } | null = await c.query(api.sessionDecisions.approvedRun, {
    api_token: token,
    decision_id: decisionId,
  });
  if (!run || run.argv.join(" ") !== TRUST_RUN || !run.approves) {
    throw new Error(`${APPROVED_RUN_ENV}=${decisionId} is not an approved workspace trust card in flight; nothing was approved`);
  }
  if (realRoot(run.approves.folder) !== realRoot(repoRoot)) {
    throw new Error(`the card approved ${run.approves.folder}, not ${realRoot(repoRoot)}; nothing was approved`);
  }
  const all = collectTrustTargets({ hooksRoot: repoRoot });
  const findings = reviewRepoTrust(repoRoot, all);
  const shown = new Map(run.approves.items.map((i) => [i.label, i.lines.join("\n")]));
  const seen = findings.filter((f) => shown.get(f.target.id) === f.target.text);
  if (seen.length > 0) recordTrust(repoRoot, seen.map((f) => f.target), all);
  return {
    approved: seen.map((f) => f.target.id),
    unseen: findings.filter((f) => !seen.includes(f)).map((f) => f.target.id),
  };
}
