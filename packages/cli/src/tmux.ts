import { execSync, execFileSync, spawnSync } from "child_process";

const ENRICHED_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");

let _hasTmux: boolean | null = null;

// A tmux client whose server dies mid-protocol wedges in a 100% CPU loop and
// ignores SIGTERM, so a Node `execSync` without a timeout leaves a zombie that
// outlives the parent process (and a default-SIGTERM timeout never reaps it).
// Always go through this wrapper for shell-form tmux calls.
export const DEFAULT_TMUX_TIMEOUT_MS = 5000;
export function tmuxExecSync(args: string[], opts?: { timeout?: number; encoding?: "utf-8"; stdio?: "ignore" | ["ignore", "pipe", "ignore"] }): string {
  const stdio = opts?.stdio ?? (opts?.encoding ? ["ignore", "pipe", "ignore"] as const : "ignore");
  const result = execFileSync("tmux", args, {
    timeout: opts?.timeout ?? DEFAULT_TMUX_TIMEOUT_MS,
    killSignal: "SIGKILL",
    encoding: opts?.encoding,
    stdio: stdio as any,
    env: { ...process.env, PATH: ENRICHED_PATH },
  });
  return typeof result === "string" ? result : "";
}

// Like tmuxExecSync but NEVER throws on a non-zero exit and hands back the exit
// status, so callers can probe state (has-session) or read a pane without a
// try/catch. Same wedge-proofing: a hard timeout + SIGKILL guarantees that a
// tmux client which busy-loops after its server dies is reaped instead of
// spinning at 100% CPU forever. On a timeout, spawnSync returns status:null —
// which every caller here already treats as "dead / not-ready / empty", the
// safe fallback. Route ALL raw spawnSync("tmux", …) reads through this.
export function tmuxRun(args: string[], opts?: { timeout?: number; env?: Record<string, string | undefined> }): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("tmux", args, {
    timeout: opts?.timeout ?? DEFAULT_TMUX_TIMEOUT_MS,
    killSignal: "SIGKILL",
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: ENRICHED_PATH, ...opts?.env },
  });
  return {
    status: r.status,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

export function hasTmux(): boolean {
  if (_hasTmux === null) {
    try {
      execSync("tmux -V", { stdio: "ignore", timeout: 2000, env: { ...process.env, PATH: ENRICHED_PATH } });
      _hasTmux = true;
    } catch {
      return false;
    }
  }
  return _hasTmux;
}

export function resetTmuxCache(): void {
  _hasTmux = null;
}

function installCommand(): string | null {
  if (process.platform === "darwin") {
    try {
      execSync("command -v brew", { stdio: "ignore", timeout: 2000 });
      return "brew install tmux";
    } catch {
      return null;
    }
  }
  if (process.platform === "linux") {
    for (const [bin, cmd] of [
      ["apt-get", "sudo apt-get install -y tmux"],
      ["dnf", "sudo dnf install -y tmux"],
      ["yum", "sudo yum install -y tmux"],
      ["pacman", "sudo pacman -S --noconfirm tmux"],
      ["apk", "sudo apk add tmux"],
    ] as const) {
      try {
        execSync(`command -v ${bin}`, { stdio: "ignore", timeout: 2000 });
        return cmd;
      } catch {}
    }
  }
  return null;
}

export function tryInstallTmux(): boolean {
  const cmd = installCommand();
  if (!cmd) return false;

  console.log(`Installing tmux: ${cmd}`);
  const result = spawnSync("sh", ["-c", cmd], {
    stdio: "inherit",
    timeout: 120_000,
    env: { ...process.env, PATH: ENRICHED_PATH },
  });

  if (result.status === 0) {
    resetTmuxCache();
    if (hasTmux()) {
      console.log("tmux installed successfully.");
      return true;
    }
  }
  return false;
}

export function ensureTmux(): boolean {
  if (hasTmux()) return true;

  console.log("tmux is required but not installed.");

  const cmd = installCommand();
  if (cmd) {
    console.log(`Install it with: ${cmd}`);
  } else if (process.platform === "darwin") {
    console.log("Install Homebrew (https://brew.sh) then run: brew install tmux");
  } else {
    console.log("Install tmux using your system package manager.");
  }

  return false;
}
