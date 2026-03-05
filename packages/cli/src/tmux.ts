import { execSync, spawnSync } from "child_process";

const ENRICHED_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");

let _hasTmux: boolean | null = null;

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
