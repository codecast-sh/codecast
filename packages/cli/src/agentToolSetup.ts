/**
 * The daemon's half of the setup card (contracts/agentToolSetup.ts): where
 * `cast browser`'s extension and `cast computer`'s grants stand on this
 * machine, and the step that moves them forward.
 *
 * Both halves are the CLI's own verbs run as children, so the card and a human
 * at a terminal go through the same code. A check is a read that puts nothing
 * on screen; a start is the human's click in the card, so it may: it opens the
 * pairing page in Chrome, or System Settings at the missing grant.
 */

import { spawn } from "node:child_process";
import { isAgentSetupTool, type AgentToolSetupArgs, type AgentToolSetupStatus } from "@codecast/shared/contracts";
import { agentSpawnPath } from "./agentSpawnPath.js";
import { resolveCastInvocation } from "./castInvocation.js";

export interface AgentToolSetupDeps {
  /** Runs `cast <args>` to completion and answers its stdout. */
  runCast: (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Starts `cast <args>` detached and answers its pid. */
  startCast?: (args: string[]) => number | undefined;
}

/**
 * The running start per tool. A second click restarts it rather than stacking
 * another waiter: `computer setup` reopens the pane the human may have closed,
 * and `extension setup` hands Chrome the pairing page again.
 */
const starts = new Map<AgentToolSetupArgs["tool"], number>();

const START_ARGS: Record<AgentToolSetupArgs["tool"], string[]> = {
  browser: ["browser", "extension", "setup"],
  computer: ["computer", "setup", "--yes"],
};

export function parseAgentToolSetupArgs(raw: string | undefined): AgentToolSetupArgs | null {
  let parsed: { tool?: unknown; op?: unknown } = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { return null; }
  if (!isAgentSetupTool(parsed.tool) || (parsed.op !== "check" && parsed.op !== "start")) return null;
  return { tool: parsed.tool, op: parsed.op };
}

export async function runAgentToolSetup(args: AgentToolSetupArgs, deps: AgentToolSetupDeps): Promise<AgentToolSetupStatus | { started: true }> {
  if (args.op === "check") return await checkAgentTool(args.tool, deps);
  const prev = starts.get(args.tool);
  if (prev) { try { process.kill(prev, "SIGTERM"); } catch { /* already gone */ } }
  const pid = (deps.startCast ?? startCastDetached)(START_ARGS[args.tool]);
  if (pid) starts.set(args.tool, pid);
  return { started: true };
}

async function checkAgentTool(tool: AgentToolSetupArgs["tool"], deps: AgentToolSetupDeps): Promise<AgentToolSetupStatus> {
  if (tool === "browser") {
    const res = await deps.runCast(["browser", "extension", "status", "--json"]);
    const raw = lastJson(res.stdout) as { paired?: boolean; connected?: boolean; chrome_running?: boolean; detail?: string } | null;
    if (!raw) return { tool, ready: false, paired: false, connected: false, chrome_running: false, detail: failure(res) };
    return {
      tool,
      ready: !!raw.connected,
      paired: !!raw.paired,
      connected: !!raw.connected,
      chrome_running: !!raw.chrome_running,
      ...(raw.detail ? { detail: raw.detail } : {}),
    };
  }
  const res = await deps.runCast(["computer", "permissions", "--json"]);
  const raw = lastJson(res.stdout) as {
    platform?: string;
    helperUnavailableReason?: string | null;
    permissions?: Array<{ id: string; status: string }>;
    message?: string;
  } | null;
  if (!raw?.permissions) {
    return { tool, ready: false, accessibility: false, screen_recording: false, supported: false, detail: raw?.message ?? failure(res) };
  }
  const granted = (id: string) => raw.permissions!.some((p) => p.id === id && p.status === "granted");
  const supported = !raw.permissions.some((p) => p.status === "unsupported") && !raw.helperUnavailableReason;
  const accessibility = granted("accessibility");
  const screenRecording = granted("screenshots");
  return {
    tool,
    ready: supported && accessibility && screenRecording,
    accessibility,
    screen_recording: screenRecording,
    supported,
    ...(raw.helperUnavailableReason ? { detail: raw.helperUnavailableReason } : !supported ? { detail: `cast computer does not run on ${raw.platform ?? "this platform"}` } : {}),
  };
}

/** The last line of stdout that parses as a JSON object (pretty-printed output is one document). */
function lastJson(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  for (const candidate of [text, ...text.split("\n").reverse()]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === "object") return v as Record<string, unknown>;
    } catch { /* next */ }
  }
  return null;
}

function failure(res: { code: number | null; stderr: string }): string {
  const tail = res.stderr.trim().split("\n").filter(Boolean).slice(-1)[0];
  return tail ? tail.replace(/\x1b\[[0-9;]*m/g, "") : `the check exited ${res.code ?? "without a code"}`;
}

function startCastDetached(args: string[]): number | undefined {
  const { cmd, prefixArgs } = resolveCastInvocation();
  const child = spawn(cmd, [...prefixArgs, ...args], {
    env: { ...process.env, PATH: agentSpawnPath() },
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => {});
  child.unref();
  return child.pid;
}
