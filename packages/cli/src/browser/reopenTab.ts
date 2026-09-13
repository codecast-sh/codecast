/**
 * Reopen a session's browser tab from the web: POST /browser/reopen.
 *
 * The "open tab" pill can only raise a tab that still exists. When the tab is
 * gone (closed by the human, by the reaper, by a browser restart) the web
 * offers to reopen the page, and this is what honours that: it runs
 * `cast browser open <url>` AS THE SESSION, so the whole open path — site
 * policy, real-versus-clone target, the pinned-tab binding, login carry —
 * is the same one the agent takes, and the session's next verb lands on the
 * reopened page instead of a second fresh tab.
 *
 * "As the session" is an identity env: the CLI keys its engine session off
 * ownerKey (owner.ts), which reads a harness session id from the environment
 * or else the tmux pane. The daemon knows both for a conversation (the same
 * candidates the watch stream resolves ownership with), and picks the one
 * the session actually pinned a tab under — the candidate whose target file
 * is newest — so the reopened tab lands under the same key.
 */

import { execFile } from "node:child_process";
import { resolveCastInvocation } from "../castInvocation.js";
import { agentSpawnPath } from "../agentSpawnPath.js";
import { engineSessionKey, engineStateDir, realSessionKey } from "./engine.js";
import { sessionTarget } from "./engineReap.js";
import { parseTabLine } from "./tabId.js";

/** Every env var ownerKey reads: the child must see exactly one identity. */
const IDENTITY_ENV = ["CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_BRIDGE_SESSION_ID", "CAST_SESSION_ID", "TMUX_PANE"];

/** How long an `open` may take: bridge start, navigation, login carry. */
const OPEN_TIMEOUT_MS = 60_000;

export interface ReopenRequest {
  url: string;
  /** Owner keys the session may hold a tab under (watchServer ownerCandidates). */
  candidates: string[];
}

export type ReopenResult =
  | { ok: true; tabId: string }
  | { ok: false; reason: "bad-request" | "open-failed"; detail?: string };

/**
 * The identity env for the candidate the session pinned its tab under. An
 * `env:<id>` candidate becomes CAST_SESSION_ID (ownerKey turns every harness
 * id into the same `env:` key, so the child lands on the session's key even
 * though it was born under a different variable); a `pane:%N` candidate
 * becomes TMUX_PANE. A `session:<id>` candidate is the detector's form, which
 * the CLI never keys a browser session by, so it reads as its `env:` twin.
 * With no target file under any candidate — the session never drove a
 * browser from here — the first candidate stands, so the reopened tab is
 * still the session's. Null only when there is no candidate at all.
 */
export function reopenIdentityEnv(candidates: string[], stateDir = engineStateDir()): Record<string, string> | null {
  const envFor = (cand: string): Record<string, string> | null => {
    const m = cand.match(/^(session|env|pane):(.+)$/);
    if (!m) return null;
    return m[1] === "pane" ? { TMUX_PANE: m[2] } : { CAST_SESSION_ID: m[2] };
  };
  let best: { env: Record<string, string>; mtimeMs: number } | null = null;
  for (const cand of candidates) {
    const env = envFor(cand);
    if (!env) continue;
    const key = engineSessionKey(cand);
    for (const engineKey of [key, realSessionKey(key)]) {
      const target = sessionTarget(engineKey, stateDir);
      if (target && (!best || target.mtimeMs > best.mtimeMs)) best = { env, mtimeMs: target.mtimeMs };
    }
  }
  if (best) return best.env;
  for (const cand of candidates) {
    const env = envFor(cand);
    if (env) return env;
  }
  return null;
}

export interface ReopenDeps {
  /** Run `cast browser open <url>` with this identity; resolves with its output. */
  runOpen(url: string, identity: Record<string, string>): Promise<{ status: number; stdout: string; stderr: string }>;
  stateDir?: string;
}

function runOpenViaCli(url: string, identity: Record<string, string>): Promise<{ status: number; stdout: string; stderr: string }> {
  const { cmd, prefixArgs } = resolveCastInvocation();
  // Under launchd the daemon's PATH has no node or bun, and the engine binary
  // starts with a node shebang (agentSpawnPath.ts) — the same re-add every
  // agent spawn makes.
  const env: Record<string, string | undefined> = { ...process.env, PATH: agentSpawnPath() };
  for (const name of IDENTITY_ENV) delete env[name];
  Object.assign(env, identity);
  return new Promise((resolve) => {
    execFile(
      cmd,
      [...prefixArgs, "browser", "open", url],
      { env, timeout: OPEN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const status = error ? ((error as { code?: unknown }).code as number | undefined) ?? 1 : 0;
        resolve({ status: typeof status === "number" ? status : 1, stdout: `${stdout ?? ""}`, stderr: `${stderr ?? ""}` });
      },
    );
  });
}

export const defaultReopenDeps: ReopenDeps = { runOpen: runOpenViaCli };

/** The last non-empty line of a failed open, for the pill's tooltip. */
function lastLine(text: string): string | undefined {
  const lines = text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : undefined;
}

export async function reopenBrowserTab(req: ReopenRequest, deps: ReopenDeps = defaultReopenDeps): Promise<ReopenResult> {
  if (!/^https?:\/\//i.test(req.url)) return { ok: false, reason: "bad-request", detail: "url must be http(s)" };
  const identity = reopenIdentityEnv(req.candidates, deps.stateDir);
  if (!identity) return { ok: false, reason: "bad-request", detail: "no session to reopen the tab for" };
  const run = await deps.runOpen(req.url, identity);
  const tabId = parseTabLine(run.stdout);
  if (run.status !== 0 || !tabId) {
    return { ok: false, reason: "open-failed", detail: lastLine(run.stderr) ?? lastLine(run.stdout) };
  }
  return { ok: true, tabId };
}
