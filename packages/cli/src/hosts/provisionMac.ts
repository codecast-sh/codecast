import { execFileSync } from "node:child_process";
import { remoteExec } from "../browser/remote.js";
import { pushCodecastConfig } from "../browser/provisionLinux.js";
import { agentCliInstallScript, parseAgentCliReport } from "../browser/provisionAgents.js";
import { readInstalledClientVersions } from "../remote/agentAuth.js";
import { remoteHome, sshBase, type RemoteHost } from "../remote/session-move.js";
import { cwdGitRoot } from "../cloud/hostGit.js";
import { readHostDeviceId, readyHostHome, remoteRepoPath, waitForDeviceOnline } from "../cloud/prepare.js";
import { convexClient } from "../remote/convexClient.js";

export const MAC_HOST_PATH = 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"';

export function macServiceLabel(user: string): string {
  if (!/^[a-zA-Z_][\w-]*$/.test(user)) throw new Error("unsupported Mac username");
  return `sh.codecast.remote.${user}`;
}

export function macBaseScript(): string {
  return `set -euo pipefail
${MAC_HOST_PATH}
[ "$(uname -s)" = Darwin ] || { echo 'This setup requires macOS' >&2; exit 1; }
command -v brew >/dev/null || { echo 'Homebrew is required on this Mac: https://brew.sh' >&2; exit 1; }
export HOMEBREW_NO_AUTO_UPDATE=1
for tool in tmux jq node python3; do
  command -v "$tool" >/dev/null || brew install "$tool"
done
command -v git >/dev/null
command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash
mkdir -p "$HOME/work" "$HOME/.codecast"
for agent in .codex .claude .gemini .grok; do
  if [ -L "$HOME/$agent" ]; then
    echo "$agent is a linked configuration directory. Use a dedicated login with regular agent directories; setup will not replace shared dotfiles." >&2
    exit 1
  fi
done
echo MAC-BASE-OK`;
}

export function macDaemonScript(host: Pick<RemoteHost, "user" | "homeDir">): string {
  const home = remoteHome(host as RemoteHost);
  if (!/^[a-zA-Z_][\w-]*$/.test(host.user) || !/^\/Users\/[\w.-]+$/.test(home)) throw new Error("unsupported Mac username or home directory");
  const label = macServiceLabel(host.user);
  return `set -euo pipefail
${MAC_HOST_PATH}
sudo -n true
if ! sudo launchctl print system/${label} >/dev/null 2>&1; then
  cast stop
  if [ -f "$HOME/Library/LaunchAgents/sh.codecast.daemon.plist" ]; then
    mv "$HOME/Library/LaunchAgents/sh.codecast.daemon.plist" "$HOME/Library/LaunchAgents/sh.codecast.daemon.plist.before-remote-setup"
  fi
fi
CAST_BIN=$(command -v cast)
case "$CAST_BIN" in *[!a-zA-Z0-9/_.-]*) echo 'Invalid cast path' >&2; exit 1;; esac
mkdir -p "$HOME/.codecast/logs"
sudo tee /Library/LaunchDaemons/${label}.plist >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>UserName</key><string>${host.user}</string>
<key>ProgramArguments</key><array><string>$CAST_BIN</string><string>_daemon</string></array>
<key>WorkingDirectory</key><string>${home}</string>
<key>EnvironmentVariables</key><dict>
<key>HOME</key><string>${home}</string>
<key>PATH</key><string>${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
<key>CODECAST_REMOTE_DEVICE</key><string>1</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${home}/.codecast/logs/remote-service.log</string>
<key>StandardErrorPath</key><string>${home}/.codecast/logs/remote-service.log</string>
</dict></plist>
PLIST
sudo chown root:wheel /Library/LaunchDaemons/${label}.plist
sudo chmod 644 /Library/LaunchDaemons/${label}.plist
plutil -lint /Library/LaunchDaemons/${label}.plist
sudo launchctl print system/${label} >/dev/null 2>&1 || sudo launchctl bootstrap system /Library/LaunchDaemons/${label}.plist
for attempt in {1..30}; do
  if sudo launchctl print system/${label} | grep -q 'state = running'; then echo MAC-DAEMON-OK; exit 0; fi
  sleep 1
done
echo 'Mac service did not start; inspect ~/.codecast/logs/remote-service.log' >&2
exit 1`;
}

function run(host: RemoteHost, script: string, timeout: number): string {
  return execFileSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, "bash -s"], {
    input: `${MAC_HOST_PATH}\n${script}`, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function provisionMacHost(host: RemoteHost, opts: { skipDaemon?: boolean; gitIdentity?: string }, log: (message: string) => void) {
  log("checking Mac and installing missing runtimes…");
  const base = run(host, macBaseScript(), 15 * 60_000);
  if (!base.includes("MAC-BASE-OK")) throw new Error(`Mac setup did not complete: ${base.slice(-600)}`);
  const { installMacCast } = await import("./updateMac.js");
  installMacCast(host, log);
  log("installing missing agent CLIs…");
  const agents = run(host, agentCliInstallScript(readInstalledClientVersions()), 15 * 60_000);
  if (!agents.includes("AGENT-CLIS-OK")) throw new Error(`Agent setup did not complete: ${agents.slice(-600)}`);
  log(parseAgentCliReport(agents));
  log("connecting Codecast and syncing agent configuration…");
  pushCodecastConfig(host);
  const localGitRoot = cwdGitRoot();
  await readyHostHome(host, { onProgress: log, force: true, localGitRoot, repoPath: localGitRoot ? remoteRepoPath(host, localGitRoot) : undefined, gitIdentity: opts.gitIdentity });
  if (!opts.skipDaemon) {
    log("starting the Mac service (runs without an open login session)…");
    const daemon = run(host, macDaemonScript(host), 60_000);
    if (!daemon.includes("MAC-DAEMON-OK")) throw new Error(`Mac service failed: ${daemon.slice(-600)}`);
  }
  const deviceId = readHostDeviceId(host);
  if (!deviceId) throw new Error("Mac did not report its Codecast device identity");
  const version = remoteExec(host, `${MAC_HOST_PATH}; cast --version`, 30_000).trim();
  if (!opts.skipDaemon) {
    const { client, api, token } = await convexClient();
    await waitForDeviceOnline(client, api, token, deviceId, log);
  }
  return { deviceId, version };
}
