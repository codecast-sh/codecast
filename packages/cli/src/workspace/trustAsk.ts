/**
 * An agent-driven acquire that hits the trust gate asks the person in
 * codecast instead of telling the agent to have them type `cast ws trust`.
 *
 * It files a `cast decide --run` card. The person reads exactly what would run,
 * presses Yes, and their machine runs `cast ws trust --expect …` as theirs
 * (daemon runApprovedCast, personEnv), so the approval is still a person's. The
 * --expect pins each target to the digest the card showed: a file that changes
 * between the ask and the press approves nothing.
 */

import * as path from "node:path";
import { commandLine } from "@codecast/shared/contracts/commandRun";
import { resolveCastInvocation } from "../castInvocation.js";
import { spawnSync } from "../proc.js";
import { diffSummary, type TrustFinding, type TrustTarget } from "./trust.js";

const SHOWN_CHARS = 1500;

export function trustRunArgv(repoRoot: string, findings: TrustFinding[]): string[] {
  return ["ws", "trust", "--repo", repoRoot, ...findings.flatMap((f) => ["--expect", `${f.target.id}=${f.target.digest}`])];
}

export function trustQuestion(repoRoot: string): string {
  return `Let agents run ${path.basename(repoRoot)}'s workspace setup on this machine?`;
}

export function trustContext(repoRoot: string, findings: TrustFinding[]): string {
  const lines = [
    `An agent needs a worktree of ${repoRoot}. Making one runs the repo's own setup code, and this machine has not approved it${findings.some((f) => f.verdict === "changed") ? " as it stands now" : ""}. Yes approves exactly what is shown here; a later change asks again.`,
  ];
  for (const { target, verdict, previous } of findings) {
    lines.push("", `**${target.id}**: ${verdict === "new" ? "not approved yet" : `changed since it was approved on ${previous?.trustedAt.slice(0, 10) ?? "?"}`}`);
    if (verdict === "changed") lines.push("", "```diff", ...diffSummary(previous?.text ?? "", target.text, 8), "```");
    const text = target.text.length > SHOWN_CHARS ? `${target.text.slice(0, SHOWN_CHARS)}\n…` : target.text;
    lines.push("", "```", text.trim(), "```");
  }
  return lines.join("\n");
}

/** Which listed targets match what the card showed; the rest are why nothing may be approved. */
export function checkExpected(all: TrustTarget[], expect: string[]): { picked: TrustTarget[]; stale: string[] } {
  const picked: TrustTarget[] = [];
  const stale: string[] = [];
  for (const raw of expect) {
    const at = raw.lastIndexOf("=");
    const id = raw.slice(0, at);
    const target = all.find((t) => t.id === id);
    if (at < 1 || !target || target.digest !== raw.slice(at + 1)) stale.push(at < 1 ? raw : id);
    else picked.push(target);
  }
  return { picked, stale };
}

/** File the card from the agent's own session. Returns its short id, or null when it could not be filed. */
export function askPersonForTrust(repoRoot: string, findings: TrustFinding[]): string | null {
  const { cmd, prefixArgs } = resolveCastInvocation();
  const run = commandLine(trustRunArgv(repoRoot, findings));
  const r = spawnSync(
    cmd,
    [...prefixArgs, "decide", trustQuestion(repoRoot), "--run", run, "--context", trustContext(repoRoot, findings), "--json"],
    { encoding: "utf-8", env: process.env, timeout: 60_000 },
  );
  if (r.status !== 0) return null;
  try {
    const out = JSON.parse(r.stdout ?? "");
    return out.short_id ?? out.id ?? null;
  } catch {
    return null;
  }
}

/** What the agent reads. The last line is what `cast flow run` repeats. */
export function trustAskLines(decision: string | null): string[] {
  return decision
    ? [
        `Asked your person to approve this repo's workspace setup in codecast (${decision}); nothing ran.`,
        `End your turn dormant: cast state --status dormant "Waiting on ${decision} to approve workspace setup". Run this again once the answer arrives (a person can also approve at a terminal with: cast ws trust).`,
      ]
    : ["Could not file the approval card. A person approves this at a terminal with: cast ws trust"];
}
