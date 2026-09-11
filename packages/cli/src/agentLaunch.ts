// The launch side of agent definitions (@codecast/shared/contracts
// agentDefinitions): the per-client flags a resolved definition's tool
// policy and mode become, shared by `cast exec --as`, the trigger scheduler's
// spawned runs and the daemon's session launch. Pure: no I/O, so every
// mapping is testable without a real agent.
//
// Tool policy support is honest per client: claude has --allowedTools and
// --disallowedTools, pi has --tools; every other client drops the policy and
// says so in `dropped`. A `propose` (read only) definition adds the safe mode
// fence the trigger scheduler already uses, so "read only" means the same
// thing on every surface.

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAgentLaunch, type AgentClientId, type AgentDefinitionSpec, type ResolvedAgentLaunch } from "@codecast/shared/contracts";

// Schedules run permissive by default (`mode: "apply"`); safe mode
// (`cast trigger add --safe`, stored as mode: "propose", or a definition with
// mode: propose) is the exception, so its fence has to be real rather than
// advisory. ONE mandate string, used both as the agent's system prompt and as
// a line in the run prompt.
export const SAFE_MODE_MANDATE =
  "This is a SAFE-mode scheduled run: strictly read-only. Investigate and report. Never modify files, run state-changing commands, commit, push, or deploy. If the task appears to require changes, describe them in your completion summary instead of making them.";

// Shell commands a safe-mode run may never execute. Deny rules bind
// MECHANICALLY — Claude Code honors them even under the --dangerously-skip-permissions
// that headless runs require (verified) — so unlike the mandate above these are a
// wall, not a request. Scoped to the subcommand, so reads through the same
// binaries still work (`git log`, `gh pr view`), as does the run's own
// `cast trigger complete` self-report.
// Accepted residual gap: a write smuggled through shell redirection
// (`echo x > f`) or an interpreter (`node -e`) is not prefix-matchable, so the
// mandate — not this list — is what covers those.
export const SAFE_MODE_DENY_RULES = [
  // Repository state and history
  "Bash(git push:*)", "Bash(git commit:*)", "Bash(git merge:*)", "Bash(git rebase:*)",
  "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(git restore:*)", "Bash(git clean:*)",
  "Bash(git stash:*)", "Bash(git apply:*)", "Bash(git tag:*)",
  // Destructive filesystem
  "Bash(rm:*)", "Bash(mv:*)", "Bash(dd:*)", "Bash(truncate:*)", "Bash(tee:*)",
  "Bash(chmod:*)", "Bash(chown:*)",
  // Deploy and publish
  "Bash(npm publish:*)", "Bash(convex deploy:*)", "Bash(npx convex deploy:*)",
  // Remote repo writes
  "Bash(gh pr merge:*)", "Bash(gh pr create:*)", "Bash(gh release:*)",
];

export const SAFE_MODE_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"];

export interface DefinitionLaunchFlags {
  /** Extra argv for the client binary (tool policy). */
  args: string[];
  /** The prompt to append to the client's system prompt, with the safe mode
   *  mandate folded in for a read only definition. */
  appendSystemPrompt?: string;
  systemPrompt?: string;
  /** Definition facts this client cannot honor. */
  dropped: string[];
}

/** The argv and prompt fragments a resolved definition adds to a launch on
 *  `agent`. Read only mode is enforced by tool denial where the client can,
 *  and by the mandate everywhere. */
export function definitionLaunchFlags(resolved: ResolvedAgentLaunch, agent: AgentClientId = resolved.agent): DefinitionLaunchFlags {
  const args: string[] = [];
  const dropped = [...resolved.dropped];
  const readOnly = resolved.mode === "propose";
  const disallowed = [...(resolved.disallowedTools ?? [])];
  if (readOnly) {
    for (const t of SAFE_MODE_DISALLOWED_TOOLS) if (!disallowed.includes(t)) disallowed.push(t);
    for (const r of SAFE_MODE_DENY_RULES) if (!disallowed.includes(r)) disallowed.push(r);
  }

  if (agent === "claude") {
    if (resolved.tools?.length) args.push("--allowedTools", resolved.tools.join(","));
    if (disallowed.length) args.push("--disallowedTools", ...disallowed);
  } else if (agent === "pi") {
    if (resolved.tools?.length) args.push("--tools", resolved.tools.join(","));
    if (disallowed.length) dropped.push(`disallowed tools (${agent} has an allowlist only)`);
  } else {
    if (resolved.tools?.length) dropped.push(`tools (${agent} has no tool allowlist flag)`);
    if (resolved.disallowedTools?.length) dropped.push(`disallowed tools (${agent} has no tool denylist flag)`);
    if (readOnly) dropped.push(`read only tool fence (${agent}; the mandate still applies)`);
  }

  let appendSystemPrompt = resolved.appendSystemPrompt;
  if (readOnly) appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${SAFE_MODE_MANDATE}` : SAFE_MODE_MANDATE;

  return { args, appendSystemPrompt, systemPrompt: resolved.systemPrompt, dropped };
}

/** A one line warning for what a launch dropped, or null when nothing was. */
export function describeDropped(name: string, dropped: string[]): string | null {
  if (!dropped.length) return null;
  return `definition ${name}: ignoring ${dropped.join("; ")}`;
}

// ── Daemon launch: a typed shell fragment past the argv allowlist ──────────

const PROMPT_PATH_RE = /^[A-Za-z0-9_./-]+$/;

/** The daemon's argv allowlist drops any arg with quotes, parens or newlines,
 *  so a definition's tool policy and prompt cannot ride buildLaunchArgs. They
 *  are appended to the typed command instead: tool flags shell-escaped, the
 *  prompt written to a 0600 file and read back with `$(cat …)`. Same door
 *  grok's stable rules use. */
export function definitionLaunchFragment(
  def: AgentDefinitionSpec,
  agent: AgentClientId,
  io: { dir: string; key: string; escape: (s: string) => string },
): { fragment: string; warning?: string } {
  const resolved = resolveAgentLaunch(def, { agent }, agent);
  const flags = definitionLaunchFlags(resolved, agent);
  const parts: string[] = flags.args.map(io.escape);
  const prompt = flags.systemPrompt ?? flags.appendSystemPrompt;
  const dropped = [...flags.dropped];
  if (prompt) {
    if (agent === "claude" || agent === "pi") {
      fs.mkdirSync(io.dir, { recursive: true, mode: 0o700 });
      const file = path.join(io.dir, `${io.key.replace(/[^A-Za-z0-9_-]/g, "_")}.md`);
      if (!PROMPT_PATH_RE.test(file)) throw new Error(`prompt path is not shell-safe: ${file}`);
      fs.writeFileSync(file, prompt, { mode: 0o600 });
      parts.push(`${flags.systemPrompt ? "--system-prompt" : "--append-system-prompt"} "$(cat ${file})"`);
    } else {
      dropped.push(`system prompt (${agent} has no system prompt flag; the spawn seeds it into the first turn)`);
    }
  }
  const warning = describeDropped(def.name, dropped) ?? undefined;
  return { fragment: parts.length ? ` ${parts.join(" ")}` : "", warning };
}
