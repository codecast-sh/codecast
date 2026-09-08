/**
 * Trust gate for the repo-authored code a workspace acquire executes.
 *
 * Two things in a repo run as the person who typed `cast ws acquire`, with no
 * prompt and no diff: the scripts in `.codecast/hooks/*.sh` and the command
 * lists in `.codecast/workspace.toml`. A pull, a teammate's push or a cloned
 * repo can change either one, and the next acquire runs the new version.
 *
 * So we record a sha256 of each of them the first time a HUMAN acquires, and
 * refuse afterwards whenever what is on disk no longer matches what was
 * recorded. Re-approving is one command: `cast ws trust`.
 *
 * Three rules make the gate worth having:
 *   - A change always refuses, even for a human, until it is trusted again.
 *   - An agent-driven acquire never trusts implicitly. It gets the same
 *     refusal on a first run as on a change, so the approval is always a
 *     person's.
 *   - The record lives in ~/.codecast, never in the repo. A file inside the
 *     repo could approve itself in the same commit that changed the hook.
 *
 * Detection's own commands (`bun install` inferred from a lockfile) are ours,
 * not the repo's, so only the manifest FILE's lists are covered.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../atomicWrite.js";
import { sessionIdFromEnv } from "../sessionIdentity.js";
import { HOOKS_DIR } from "./hooks.js";
import { parseManifest } from "./manifest.js";
import { MANIFEST_REL_PATH } from "./resolver.js";

/** One piece of repo-authored code an acquire may execute. */
export interface TrustTarget {
  kind: "hook" | "commands";
  /** Stable, readable key: a repo-relative script path or a manifest slot. */
  id: string;
  /** Exactly what will run — the script body, or the slot's command lines. */
  text: string;
  /** sha256 of `text`, hex. */
  digest: string;
}

/** What a human approved, and when. */
export interface TrustedEntry {
  digest: string;
  /** The approved text, kept so a refusal can show what changed. */
  text: string;
  trustedAt: string;
}

/** A repo's approvals, keyed by target id. */
export type RepoTrust = Record<string, TrustedEntry>;

export interface TrustFinding {
  target: TrustTarget;
  verdict: "new" | "changed";
  /** The approved version, when this target was ever approved. */
  previous?: TrustedEntry;
}

export class WorkspaceTrustError extends Error {
  constructor(
    message: string,
    public readonly findings: TrustFinding[],
    public readonly agentDriven: boolean,
  ) {
    super(message);
    this.name = "WorkspaceTrustError";
  }
}

export function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** Absolute path of the trust store. Outside every repo, on purpose. */
export function trustStorePath(): string {
  const dir = process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast");
  return path.join(dir, "workspace-trust.json");
}

function readStore(): Record<string, RepoTrust> {
  try {
    const raw = JSON.parse(fs.readFileSync(trustStorePath(), "utf-8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, RepoTrust>;
    }
  } catch {
    /* missing or corrupt: nothing is trusted, which fails closed */
  }
  return {};
}

/** Canonical store key. realpath so /tmp and /private/tmp are one repo. */
function repoKey(repoRoot: string): string {
  try {
    return fs.realpathSync(repoRoot);
  } catch {
    return path.resolve(repoRoot);
  }
}

export function readRepoTrust(repoRoot: string): RepoTrust {
  return readStore()[repoKey(repoRoot)] ?? {};
}

/**
 * Approve `trust` for this repo. When `known` is given, records for ids
 * outside it are dropped — a hook that no longer exists keeps no approval.
 */
export function recordTrust(
  repoRoot: string,
  trust: TrustTarget[],
  known?: TrustTarget[],
): RepoTrust {
  const store = readStore();
  const key = repoKey(repoRoot);
  const previous = store[key] ?? {};
  const next: RepoTrust = {};
  const keep = known ? new Set(known.map((t) => t.id)) : null;
  for (const [id, entry] of Object.entries(previous)) {
    if (!keep || keep.has(id)) next[id] = entry;
  }
  const now = new Date().toISOString();
  for (const target of trust) {
    const prior = previous[target.id];
    next[target.id] = {
      digest: target.digest,
      text: target.text,
      // Unchanged targets keep their original date, so "trusted <date>" in a
      // later refusal names when the person actually approved it.
      trustedAt: prior?.digest === target.digest ? prior.trustedAt : now,
    };
  }
  store[key] = next;
  const file = trustStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFile(file, JSON.stringify(store, null, 2));
  return next;
}

/** Forget every approval for a repo. */
export function clearRepoTrust(repoRoot: string): void {
  const store = readStore();
  delete store[repoKey(repoRoot)];
  const file = trustStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFile(file, JSON.stringify(store, null, 2));
}

// ---------------------------------------------------------------------------
// What is covered
// ---------------------------------------------------------------------------

export interface CollectOptions {
  /** Repo holding `.codecast/hooks/`. */
  hooksRoot: string;
  /** Repo holding `.codecast/workspace.toml`. Defaults to `hooksRoot`. */
  manifestRoot?: string;
  /** Skip the hook scripts (the caller passed skipHooks). Default true. */
  hooks?: boolean;
  /** Skip the manifest commands (the caller passed skipSetup). Default true. */
  commands?: boolean;
}

/** The target id of one manifest command list. */
export function commandTargetId(slot: string): string {
  return `${MANIFEST_REL_PATH} [${slot}]`;
}

/** The teardown commands a destroy runs. */
export const TEARDOWN_TARGET_ID = commandTargetId("teardown.run");

/** Every hook script and manifest command list the given roots carry. */
export function collectTrustTargets(opts: CollectOptions): TrustTarget[] {
  const targets: TrustTarget[] = [];

  if (opts.hooks !== false) {
    const dir = path.join(opts.hooksRoot, HOOKS_DIR);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".sh")).sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, name), "utf-8");
      } catch {
        continue;
      }
      targets.push({
        kind: "hook",
        id: `${HOOKS_DIR}/${name}`,
        text,
        digest: digestOf(text),
      });
    }
  }

  if (opts.commands !== false) {
    const root = opts.manifestRoot ?? opts.hooksRoot;
    const file = parseManifest(path.join(root, MANIFEST_REL_PATH));
    if (file) {
      const slots: Array<[string, string[]]> = [
        ["setup.install", file.setup.install],
        ["setup.generate", file.setup.generate],
        ["setup.migrate", file.setup.migrate],
        ["teardown.run", file.teardown.run],
      ];
      for (const [slot, commands] of slots) {
        if (commands.length === 0) continue;
        // One target per slot, not per command: an id carrying a list index
        // would report every command below an insertion as changed.
        const text = commands.join("\n");
        targets.push({
          kind: "commands",
          id: commandTargetId(slot),
          text,
          digest: digestOf(text),
        });
      }
    }
  }

  return targets;
}

/** Targets that are new or no longer match what was approved. */
export function reviewTrust(trusted: RepoTrust, targets: TrustTarget[]): TrustFinding[] {
  const findings: TrustFinding[] = [];
  for (const target of targets) {
    const previous = trusted[target.id];
    if (!previous) findings.push({ target, verdict: "new" });
    else if (previous.digest !== target.digest) {
      findings.push({ target, verdict: "changed", previous });
    }
  }
  return findings;
}

/** The ids in these roots that are not approved right now. */
export function untrustedTargetIds(repoRoot: string, opts: CollectOptions): Set<string> {
  const findings = reviewTrust(readRepoTrust(repoRoot), collectTrustTargets(opts));
  return new Set(findings.map((f) => f.target.id));
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Is this process an agent rather than a person at a keyboard?
 *
 * `sessionIdFromEnv` is the CLI's standing witness — the session uuid every
 * agent exports to its shell children — plus the flag the daemon sets on the
 * acquires it drives itself.
 */
export function isAgentContext(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CODECAST_AGENT_DRIVEN === "1") return true;
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return true;
  return sessionIdFromEnv(env) !== null;
}

/**
 * Every var isAgentContext reads. A test that must state its own context
 * clears these first; a unit test keeps the list honest against the function.
 */
export const AGENT_CONTEXT_ENV_VARS = [
  "CODECAST_AGENT_DRIVEN",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_SESSION_ID",
  "CODECAST_SESSION_ID",
  "CODECAST_MANAGED_SESSION",
] as const;

export interface TrustGateOptions extends CollectOptions {
  /** Repo the approvals are recorded against. */
  repoRoot: string;
  /** The human said yes: `cast ws trust`, or `--trust` on acquire. */
  grant?: boolean;
  /** Override the env sniff. The daemon passes true for its own acquires. */
  agentDriven?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Refuse unless every hook script and manifest command list on disk matches
 * what a human approved. Returns the covered targets.
 */
export function enforceWorkspaceTrust(opts: TrustGateOptions): TrustTarget[] {
  const targets = collectTrustTargets(opts);
  if (targets.length === 0) return targets;

  const findings = reviewTrust(readRepoTrust(opts.repoRoot), targets);
  const agent = opts.agentDriven ?? isAgentContext(opts.env);

  if (opts.grant) {
    recordTrust(opts.repoRoot, targets, targets);
    return targets;
  }
  if (findings.length === 0) return targets;
  if (agent || findings.some((f) => f.verdict === "changed")) {
    throw new WorkspaceTrustError(refusalMessage(opts.repoRoot, findings, agent), findings, agent);
  }
  // A person, running this repo's setup for the first time. Record what they
  // just ran, so any later change has something to differ from.
  recordTrust(opts.repoRoot, targets, targets);
  return targets;
}

/** The refusal a human reads: what changed, in which file, and how to approve. */
export function refusalMessage(
  repoRoot: string,
  findings: TrustFinding[],
  agentDriven: boolean,
): string {
  const lines: string[] = [
    `workspace setup in ${repoRoot} runs code this machine has not approved:`,
    "",
  ];
  for (const { target, verdict, previous } of findings) {
    if (verdict === "new") {
      lines.push(`  ${target.id} — not approved yet`);
    } else {
      const when = previous ? previous.trustedAt.slice(0, 10) : "?";
      lines.push(`  ${target.id} — changed since it was approved on ${when}`);
      for (const line of diffSummary(previous?.text ?? "", target.text)) {
        lines.push(`    ${line}`);
      }
    }
  }
  lines.push("");
  lines.push(
    agentDriven
      ? "This acquire is agent driven, so it cannot approve them. Ask a human to review the files above and run: cast ws trust"
      : "Review the files above, then approve them with: cast ws trust",
  );
  return lines.join("\n");
}

/** A few added and removed lines, enough to see what a change did. */
export function diffSummary(before: string, after: string, maxLines = 3): string[] {
  const count = (text: string) => {
    const map = new Map<string, number>();
    for (const line of text.split("\n")) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const only = (a: Map<string, number>, b: Map<string, number>) => {
    const out: string[] = [];
    for (const [line, n] of a) {
      const extra = n - (b.get(line) ?? 0);
      for (let i = 0; i < extra; i++) if (line.trim()) out.push(line.trim());
    }
    return out;
  };
  const oldLines = count(before);
  const newLines = count(after);
  const removed = only(oldLines, newLines);
  const added = only(newLines, oldLines);

  const out: string[] = [];
  for (const line of removed.slice(0, maxLines)) out.push(`- ${line}`);
  for (const line of added.slice(0, maxLines)) out.push(`+ ${line}`);
  if (removed.length > maxLines || added.length > maxLines) {
    out.push(`(${added.length} line(s) added, ${removed.length} removed)`);
  }
  return out;
}
