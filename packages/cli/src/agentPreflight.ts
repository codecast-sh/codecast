// `cast doctor --agents`: is each coding agent this machine would launch
// installed, new enough and signed in? Doctor's round trip uses a stand-in
// agent, which proves codecast's loop but not the user's Claude Code or Codex,
// and those are a new user's first failures. Each agent is found the way the
// daemon under launchd would find it (the recorded login shell PATH, then the
// usual install folders), asked its version, and given one short real prompt.
// The prompt leaves no session behind: claude runs without persistence and
// settings, codex ephemeral and read-only, from an empty scratch folder.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "./proc.js";
import { whichBin } from "./proc.js";
import { defaultConfigDir } from "./config/configDir.js";
import { LOGIN_PATH_FILENAME, captureLoginShellPath } from "./loginShellPath.js";
import { callArgs, callEnv } from "./subscriptionCall.js";

export type AgentPreflightStatus = "ok" | "not_found" | "too_old" | "timed_out" | "auth_failed" | "smoke_failed";

export interface AgentPreflight {
  agent: "claude" | "codex";
  status: AgentPreflightStatus;
  path?: string;
  version?: string;
  min_version: string;
  detail?: string;
  ms?: number;
}

type Spec = {
  agent: AgentPreflight["agent"];
  /** The oldest release whose launch flags codecast uses (--session-id, -p stream-json / app-server, exec --ephemeral). */
  minVersion: string;
  /** Folders installers put the binary in, after PATH. */
  folders: (home: string) => string[];
  smokeArgs: string[];
};

const SMOKE_PROMPT = "Reply with exactly the word: ok";

export const AGENT_SPECS: Spec[] = [
  {
    agent: "claude",
    minVersion: "2.0.0",
    folders: (home) => [path.join(home, ".claude/local"), path.join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"],
    // A bare one-turn call (subscriptionCall.ts). Sonnet, because a subscription
    // login can answer Haiku with 429 while the sign-in itself is fine.
    smokeArgs: [...callArgs({ model: "sonnet" }), "--no-session-persistence", SMOKE_PROMPT],
  },
  {
    agent: "codex",
    minVersion: "0.50.0",
    folders: (home) => [path.join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global/bin")],
    smokeArgs: ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", SMOKE_PROMPT],
  },
];

const AUTH_FAILURE = /not logged in|please run \/?login|invalid api key|authentication[_ ]error|oauth token (has )?expired|401\b|unauthorized|codex login|sign in again|credit balance is too low/i;

/** The search PATH: the recorded login shell PATH (or a fresh capture), then this process's. */
export function preflightSearchPath(configDir = defaultConfigDir(), capture = captureLoginShellPath): string {
  let login: string | null = null;
  try { login = fs.readFileSync(path.join(configDir, LOGIN_PATH_FILENAME), "utf8").split("\n")[0].trim() || null; } catch {}
  return [login ?? capture(), process.env.PATH].filter(Boolean).join(":");
}

export function parseVersion(out: string): string | null {
  return out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** What one smoke run says about the agent. */
export function classifySmoke(run: { code: number | null; timedOut: boolean; output: string }): { status: AgentPreflightStatus; detail?: string } {
  if (run.timedOut) return { status: "timed_out" };
  const tail = run.output.trim().split("\n").slice(-3).join(" ").slice(-300);
  if (AUTH_FAILURE.test(run.output)) return { status: "auth_failed", detail: tail };
  if (run.code === 0 && /\bok\b/i.test(run.output)) return { status: "ok" };
  return { status: "smoke_failed", detail: tail || `exit ${run.code}` };
}

type Run = { code: number | null; timedOut: boolean; output: string };
export type Runner = (bin: string, args: string[], opts: { timeoutMs: number; cwd: string; env: NodeJS.ProcessEnv }) => Promise<Run>;

const runProcess: Runner = (bin, args, { timeoutMs, cwd, env }) =>
  new Promise((resolve) => {
    // Its own process group, so a timeout kills what the agent started too:
    // a grandchild holding the pipes kept `close` from firing for 20s.
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    let timedOut = false;
    const keep = (c: Buffer) => { output = (output + c.toString()).slice(-8000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      resolve({ code: null, timedOut, output });
    }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, timedOut, output: String(err.message) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, timedOut, output }); });
  });

/** The launching session's markers stay out of the probe's env, so its hooks do not report into this session. */
const DROP_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODECAST_LAUNCH_TOKEN", "CODECAST_SESSION_ID", "TMUX", "TMUX_PANE"];

export async function preflightAgents(opts: {
  agents?: Array<AgentPreflight["agent"]>;
  smoke?: boolean;
  timeoutMs?: number;
  searchPath?: string;
  run?: Runner;
  home?: string;
  /** Also look in the usual install folders (off in tests). */
  knownFolders?: boolean;
} = {}): Promise<AgentPreflight[]> {
  const home = opts.home ?? os.homedir();
  const searchPath = opts.searchPath ?? preflightSearchPath();
  const run = opts.run ?? runProcess;
  // A loaded machine takes 15s just to start node for `codex --version`.
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const specs = AGENT_SPECS.filter((s) => !opts.agents || opts.agents.includes(s.agent));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cast-preflight-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: searchPath, ...callEnv(false) };
  for (const k of DROP_ENV) delete env[k];
  try {
    return await Promise.all(specs.map(async (spec): Promise<AgentPreflight> => {
      const base = { agent: spec.agent, min_version: spec.minVersion };
      const bin = whichBin(spec.agent, [searchPath, ...(opts.knownFolders === false ? [] : spec.folders(home))].join(":"));
      if (!bin) return { ...base, status: "not_found" };
      const v = await run(bin, ["--version"], { timeoutMs: 45_000, cwd: scratch, env });
      const version = parseVersion(v.output) ?? undefined;
      if (v.timedOut) return { ...base, path: bin, status: "timed_out", detail: "--version did not answer" };
      if (version && !versionAtLeast(version, spec.minVersion)) return { ...base, path: bin, version, status: "too_old" };
      if (opts.smoke === false) return { ...base, path: bin, version, status: "ok" };
      const started = Date.now();
      const smoke = await run(bin, spec.smokeArgs, { timeoutMs, cwd: scratch, env });
      return { ...base, path: bin, version, ...classifySmoke(smoke), ms: Date.now() - started };
    }));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
