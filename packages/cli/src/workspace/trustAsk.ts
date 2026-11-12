/**
 * An agent-driven acquire that hits the trust gate asks the person in
 * codecast instead of telling the agent to have them type `cast ws trust`.
 *
 * It files a `cast decide --run` card. The person reads exactly what would run,
 * presses Yes, and their machine runs `cast ws trust --expect …` as theirs
 * (daemon runApprovedCast, personEnv), so the approval is still a person's. The
 * card shows every file in full, never a cut, and --expect pins each target to
 * the digest it showed: a file that changes between the ask and the press
 * approves nothing.
 */

import * as path from "node:path";
import { commandLine } from "@codecast/shared/contracts/commandRun";
import { resolveCastInvocation } from "../castInvocation.js";
import { spawnSync } from "../proc.js";
import { diffSummary, type TrustFinding, type TrustTarget } from "./trust.js";

/** Past this a card cannot show every line in full, so no card is filed: approving code nobody was shown is what the gate exists to stop. */
export const MAX_CARD_CHARS = 60_000;

export function trustRunArgv(repoRoot: string, findings: TrustFinding[]): string[] {
  return ["ws", "trust", "--repo", repoRoot, ...findings.flatMap((f) => ["--expect", `${f.target.id}=${f.target.digest}`])];
}

export function trustQuestion(repoRoot: string): string {
  return `Let agents run ${path.basename(repoRoot)}'s workspace setup on this machine?`;
}

/** A fence longer than any backtick run in the text, so no file can close it early and hide what follows. */
function fenced(text: string, lang = ""): string[] {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return [`${fence}${lang}`, text.replace(/\n$/, ""), fence];
}

export function trustContext(findings: TrustFinding[]): string | null {
  const lines = [
    `An agent needs a worktree of this repo. Making one runs the repo's own setup code below, which this machine has not approved${findings.some((f) => f.verdict === "changed") ? " as it stands now" : ""}. Every line of it is shown. Yes approves these versions; a later change asks again.`,
  ];
  for (const { target, verdict, previous } of findings) {
    lines.push("", `**${target.id}**: ${verdict === "new" ? "not approved yet" : `changed since it was approved on ${previous?.trustedAt.slice(0, 10) ?? "?"}`}`);
    if (verdict === "changed") lines.push("", "Changed lines (a summary; all of it follows):", "", ...fenced(diffSummary(previous?.text ?? "", target.text, 8).join("\n"), "diff"));
    lines.push("", target.kind === "hook" ? "The whole script:" : "Every command it runs:", "", ...fenced(target.text));
  }
  const md = lines.join("\n");
  return md.length > MAX_CARD_CHARS ? null : md;
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

/** File the card from the agent's own session. Returns its short id; null when it could not be filed or the setup is too long to show whole. */
export function askPersonForTrust(repoRoot: string, findings: TrustFinding[]): string | null {
  const context = trustContext(findings);
  if (context === null) return null;
  const { cmd, prefixArgs } = resolveCastInvocation();
  const run = commandLine(trustRunArgv(repoRoot, findings));
  const r = spawnSync(
    cmd,
    [...prefixArgs, "decide", trustQuestion(repoRoot), "--run", run, "--context", context, "--json"],
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
    : ["Could not ask in codecast (no card was filed, or the setup is too long to show whole on one). A person reads the files listed above, then approves at a terminal with: cast ws trust"];
}
