import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, writeFileSync, unlinkSync, openSync } from "fs";

export interface AgentHandle {
  id: string;
  taskShortId: string;
  runtime: string;
  spawnedAt: number;
  pid?: number;
}

export interface AgentOutput {
  text: string;
  markers: {
    status: "blocked" | "needs_context" | "done_with_concerns" | null;
    detail: string;
  };
}

export interface SpawnOpts {
  sessionName: string;
  prompt: string;
  model: string;
  workingDir: string;
  resourceIndex?: number;
  taskShortId?: string;
}

export interface AgentRuntime {
  name: string;
  available(): boolean;
  spawn(opts: SpawnOpts): AgentHandle;
  isAlive(handle: AgentHandle): boolean;
  getOutput(handle: AgentHandle, lines?: number): AgentOutput;
  kill(handle: AgentHandle): void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  name: string;
  execCommand(command: string, opts?: { cwd?: string; timeout?: number }): ExecResult;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  fileExists(path: string): boolean;
  spawnAgent(opts: SpawnOpts): AgentHandle;
}

export class LocalSandbox implements Sandbox {
  name = "local";
  private runtime: AgentRuntime;

  constructor(runtime?: AgentRuntime) {
    this.runtime = runtime || detectRuntime();
  }

  execCommand(command: string, opts?: { cwd?: string; timeout?: number }): ExecResult {
    const result = spawnSync("sh", ["-c", command], {
      encoding: "utf-8",
      cwd: opts?.cwd,
      timeout: opts?.timeout || 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  }

  readFile(path: string): string {
    const { readFileSync } = require("fs");
    return readFileSync(path, "utf-8");
  }

  writeFile(path: string, content: string): void {
    const { writeFileSync } = require("fs");
    writeFileSync(path, content, "utf-8");
  }

  fileExists(path: string): boolean {
    return existsSync(path);
  }

  spawnAgent(opts: SpawnOpts): AgentHandle {
    return this.runtime.spawn(opts);
  }
}

const childProcesses = new Map<string, ChildProcess>();

function logPath(sessionName: string): string {
  return `/tmp/codecast-agent-${sessionName}.log`;
}

function whichSync(cmd: string): boolean {
  const r = spawnSync("which", [cmd], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  return r.status === 0;
}

function readLogTail(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  const r = spawnSync("tail", ["-n", String(lines), path], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  return r.status === 0 ? (r.stdout || "") : "";
}

export function parseAgentMarkers(output: string): AgentOutput["markers"] {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    const blockedMatch = line.match(/^(?:\*\*)?(?:Status:\s*)?BLOCKED(?:\*\*)?[:\s]+(.+)/i);
    if (blockedMatch) return { status: "blocked", detail: blockedMatch[1].trim() };
    const needsMatch = line.match(/^(?:\*\*)?(?:Status:\s*)?NEEDS_CONTEXT(?:\*\*)?[:\s]+(.+)/i);
    if (needsMatch) return { status: "needs_context", detail: needsMatch[1].trim() };
    const concernsMatch = line.match(/^(?:\*\*)?(?:Status:\s*)?DONE_WITH_CONCERNS(?:\*\*)?[:\s]+(.+)/i);
    if (concernsMatch) return { status: "done_with_concerns", detail: concernsMatch[1].trim() };
  }
  return { status: null, detail: "" };
}

export class ClaudeCodeRuntime implements AgentRuntime {
  name = "claude-code";

  available(): boolean {
    return whichSync("claude");
  }

  spawn(opts: SpawnOpts): AgentHandle {
    const log = logPath(opts.sessionName);
    const logFd = openSync(log, "w");

    const child = spawn("claude", [
      "-p", opts.prompt,
      "--model", opts.model,
      "--permission-mode", "bypassPermissions",
    ], {
      cwd: opts.workingDir,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    child.unref();

    const handle: AgentHandle = {
      id: opts.sessionName,
      taskShortId: opts.taskShortId || "",
      runtime: this.name,
      spawnedAt: Date.now(),
      pid: child.pid,
    };

    childProcesses.set(opts.sessionName, child);
    return handle;
  }

  isAlive(handle: AgentHandle): boolean {
    const child = childProcesses.get(handle.id);
    if (child) return child.exitCode === null;
    if (!handle.pid) return false;
    const r = spawnSync("kill", ["-0", String(handle.pid)], { stdio: ["pipe", "pipe", "pipe"] });
    return r.status === 0;
  }

  getOutput(handle: AgentHandle, lines = 500): AgentOutput {
    const text = readLogTail(logPath(handle.id), lines);
    return { text, markers: parseAgentMarkers(text) };
  }

  kill(handle: AgentHandle): void {
    const child = childProcesses.get(handle.id);
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      childProcesses.delete(handle.id);
      return;
    }
    if (handle.pid) {
      spawnSync("kill", [String(handle.pid)], { stdio: ["pipe", "pipe", "pipe"] });
    }
    childProcesses.delete(handle.id);
  }
}

export class CodexRuntime implements AgentRuntime {
  name = "codex";

  available(): boolean {
    return whichSync("codex");
  }

  spawn(opts: SpawnOpts): AgentHandle {
    const log = logPath(opts.sessionName);
    const logFd = openSync(log, "w");

    const child = spawn("codex", [
      "exec", opts.prompt,
      "-m", opts.model,
    ], {
      cwd: opts.workingDir,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    child.unref();

    const handle: AgentHandle = {
      id: opts.sessionName,
      taskShortId: opts.taskShortId || "",
      runtime: this.name,
      spawnedAt: Date.now(),
      pid: child.pid,
    };

    childProcesses.set(opts.sessionName, child);
    return handle;
  }

  isAlive(handle: AgentHandle): boolean {
    const child = childProcesses.get(handle.id);
    if (child) return child.exitCode === null;
    if (!handle.pid) return false;
    const r = spawnSync("kill", ["-0", String(handle.pid)], { stdio: ["pipe", "pipe", "pipe"] });
    return r.status === 0;
  }

  getOutput(handle: AgentHandle, lines = 500): AgentOutput {
    const text = readLogTail(logPath(handle.id), lines);
    return { text, markers: parseAgentMarkers(text) };
  }

  kill(handle: AgentHandle): void {
    const child = childProcesses.get(handle.id);
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      childProcesses.delete(handle.id);
      return;
    }
    if (handle.pid) {
      spawnSync("kill", [String(handle.pid)], { stdio: ["pipe", "pipe", "pipe"] });
    }
    childProcesses.delete(handle.id);
  }
}

export class TmuxRuntime implements AgentRuntime {
  name = "tmux";

  available(): boolean {
    return whichSync("tmux");
  }

  spawn(opts: SpawnOpts): AgentHandle {
    const promptFile = `/tmp/agent-prompt-${opts.sessionName}.md`;
    writeFileSync(promptFile, opts.prompt);

    spawnSync("tmux", ["new-session", "-d", "-s", opts.sessionName, "-c", opts.workingDir,
      `claude --model ${opts.model} --dangerously-skip-permissions`], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.waitForReady(opts.sessionName);

    const bufName = `agent-spawn-${opts.sessionName}`;
    spawnSync("tmux", ["load-buffer", "-b", bufName, promptFile], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    spawnSync("tmux", ["paste-buffer", "-t", opts.sessionName, "-b", bufName, "-d"], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });

    spawnSync("sleep", ["1"]);
    spawnSync("tmux", ["send-keys", "-t", opts.sessionName, "Enter"], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    try { unlinkSync(promptFile); } catch {}

    return {
      id: opts.sessionName,
      taskShortId: opts.taskShortId || "",
      runtime: this.name,
      spawnedAt: Date.now(),
    };
  }

  private waitForReady(sessionName: string, maxWaitMs = 30000): void {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const pane = spawnSync("tmux", ["capture-pane", "-p", "-J", "-t", `${sessionName}:0.0`, "-S", "-50"], {
        encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
      });
      if (pane.status === 0 && pane.stdout?.includes("❯")) return;
      spawnSync("sleep", ["0.5"]);
    }
  }

  isAlive(handle: AgentHandle): boolean {
    const r = spawnSync("tmux", ["has-session", "-t", handle.id], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    return r.status === 0;
  }

  getOutput(handle: AgentHandle, lines = 500): AgentOutput {
    const r = spawnSync("tmux", ["capture-pane", "-p", "-J", "-t", `${handle.id}:0.0`, "-S", `-${lines}`], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
    const text = r.status === 0 ? (r.stdout || "") : "";
    return { text, markers: parseAgentMarkers(text) };
  }

  kill(handle: AgentHandle): void {
    spawnSync("tmux", ["kill-session", "-t", handle.id], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    });
  }
}

export function detectRuntime(): AgentRuntime {
  if (whichSync("claude")) return new ClaudeCodeRuntime();
  if (whichSync("codex")) return new CodexRuntime();
  if (whichSync("tmux")) return new TmuxRuntime();
  throw new Error("No agent runtime available. Install claude, codex, or tmux.");
}
