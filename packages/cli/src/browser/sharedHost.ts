/**
 * A Linux host shared by several teammates (docs/architecture/shared-hosts.md).
 *
 * Each person has their own Linux user, codecast login, Claude subscription
 * and daemon. Every daemon is a peer device, never a remote one: it signs in
 * on its own, creates its own worktrees, and no laptop pushes credentials to
 * it. `cast hosts provision <id> --shared` turns a host into one;
 * `--add-user <linux-user>` adds a person.
 *
 * Every script here runs over ssh as the host's provisioning user, who has
 * passwordless sudo; the per-user half runs as the new user through sudo -u.
 */

import { hostReleaseScript } from "../hosts/installRelease.js";
import { agentCliInstallScript } from "./provisionAgents.js";
import { SHARED_HOST_MARKER } from "../remote/sharedHostGuard.js";

export const USER_DAEMON_UNIT = "codecast-daemon-user@";

/** Whether `name` is safe as a Linux login and a systemd instance name. */
export function isLinuxUserName(name: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(name);
}

export function isGitHubLogin(login: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login);
}

/** A user's own tool directories, first on every PATH they get: shell, ssh command, daemon. */
export function userToolPath(home: string): string {
  return [".local/bin", ".bun/bin", ".grok/bin", ".opencode/bin"].map((d) => `${home}/${d}`).join(":") + ":/usr/local/bin:/usr/bin:/bin";
}

/**
 * The PATH line at the TOP of a user's ~/.bashrc. Above Ubuntu's "not
 * interactive, return" guard on purpose: Ubuntu's bash reads ~/.bashrc for a
 * command run over ssh, so `ssh <user>@host cast ...` finds the user's own
 * tools too, not only an interactive shell.
 */
export const BASHRC_PATH_MARK = "# codecast shared host: own tools first, also for ssh commands";

function bashrcPathScript(): string {
  return `if ! grep -qF '${BASHRC_PATH_MARK}' "$HOME/.bashrc" 2>/dev/null; then
  { echo '${BASHRC_PATH_MARK}'
    echo 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.grok/bin:$HOME/.opencode/bin:$PATH"'
    cat "$HOME/.bashrc" 2>/dev/null || true; } > "$HOME/.bashrc.codecast" && mv "$HOME/.bashrc.codecast" "$HOME/.bashrc"
fi`;
}

/**
 * Claude's first-run screens, answered ahead of time so a headless session
 * never stops on one: onboarding and theme, the folder trust prompt (trust is
 * inherited by every folder under a trusted one, so trusting HOME covers each
 * worktree), and the bypass-permissions consent. The consent is
 * `skipDangerousModePermissionPrompt` in settings.json: on 2.1.301 the
 * ~/.claude.json `bypassPermissionsModeAccepted` flag alone still shows the
 * dialog, the settings key alone does not, and neither needs a login yet.
 * Merges, so a re-run keeps everything else the user has set.
 */
export function claudeFirstRunScript(): string {
  return `python3 - "$HOME" <<'PY'
import json, os, sys
home = sys.argv[1]
def merge(path, apply):
    try:
        with open(path) as f: data = json.load(f)
    except Exception:
        data = {}
    apply(data)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".codecast"
    with open(tmp, "w") as f: json.dump(data, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
def state(d):
    d["hasCompletedOnboarding"] = True
    d.setdefault("theme", "dark")
    d["bypassPermissionsModeAccepted"] = True
    d.setdefault("projects", {}).setdefault(home, {}).update({"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True})
def settings(d):
    d["skipDangerousModePermissionPrompt"] = True
merge(os.path.join(home, ".claude.json"), state)
merge(os.path.join(home, ".claude", "settings.json"), settings)
print("claude-first-run=ok")
PY`;
}

/**
 * The template unit that runs one person's daemon, and the path unit that
 * starts it the moment that person's `cast login` writes their config, so
 * nobody but the admin needs sudo. Peer mode: no CODECAST_REMOTE_DEVICE, and
 * the person's own Claude token comes from ~/.codecast/claude.env.
 */
export function userDaemonUnits(): { service: string; path: string } {
  return {
    service: `[Unit]
Description=codecast daemon for %i (shared host)
After=network-online.target
Wants=network-online.target
ConditionPathExists=/home/%i/.codecast/config.json
[Service]
User=%i
Environment=CODECAST_CLOUD=1
Environment=HOME=/home/%i
Environment=PATH=${userToolPath("/home/%i")}
EnvironmentFile=-/home/%i/.codecast/claude.env
WorkingDirectory=/home/%i
ExecStart=/home/%i/.local/bin/cast _daemon
Restart=always
RestartSec=5
KillMode=process
[Install]
WantedBy=multi-user.target
`,
    path: `[Unit]
Description=start the codecast daemon for %i once they sign in
[Path]
PathExists=/home/%i/.codecast/config.json
Unit=${USER_DAEMON_UNIT}%i.service
[Install]
WantedBy=paths.target
`,
  };
}

/**
 * The first shared step, before any credential step: the marker, so the host
 * itself refuses every laptop's pushes and link from here on, and the owner's
 * PATH line, which the rest of provisioning then finds its tools through.
 */
export function sharedHostMarkScript(): string {
  return `set -euo pipefail
sudo install -d -m 755 /etc/codecast
sudo touch ${SHARED_HOST_MARKER}
${bashrcPathScript()}
echo SHARED-MARK-OK`;
}

/**
 * Make the host shared, as its provisioning user. Idempotent. Writes the
 * marker and the per-user units, gives the owner the same PATH line every
 * user gets, answers the owner's Claude first-run screens, and removes every
 * /usr/local/bin link into a home directory: homes are 750 on Ubuntu, so such
 * a link is "permission denied" (systemd 203/EXEC) for everyone but its
 * owner. Each user runs their own copies from their own PATH instead.
 */
export function sharedHostSetupScript(): string {
  const units = userDaemonUnits();
  return `set -euo pipefail
sudo install -d -m 755 /etc/codecast
sudo touch ${SHARED_HOST_MARKER}
# A Claude login an earlier, unshared provision pushed: a refresh here would rotate it and log that laptop out.
rm -f "$HOME/.claude/.credentials.json"
sudo tee /etc/systemd/system/${USER_DAEMON_UNIT}.service >/dev/null <<'UNIT'
${units.service}UNIT
sudo tee /etc/systemd/system/${USER_DAEMON_UNIT}.path >/dev/null <<'UNIT'
${units.path}UNIT
sudo systemctl daemon-reload
for l in /usr/local/bin/*; do
  [ -L "$l" ] || continue
  case "$(readlink "$l")" in /home/*) sudo rm -f "$l"; echo "unlinked $l";; esac
done
${bashrcPathScript()}
${claudeFirstRunScript()}
echo SHARED-HOST-OK`;
}

/**
 * Create a person's Linux user, as root (through the provisioning user's
 * sudo). Idempotent: an existing user is kept, and their ssh keys are
 * re-read from GitHub on every run, so re-running is how keys refresh.
 * No sudo for them: their daemon starts through the path unit.
 */
export function addUserRootScript(user: string, github?: string): string {
  if (!isLinuxUserName(user)) throw new Error(`not a Linux user name: ${user}`);
  if (github !== undefined && !isGitHubLogin(github)) throw new Error(`not a GitHub login: ${github}`);
  const keys = github
    ? `keys=$(curl -fsS --max-time 15 https://github.com/${github}.keys)
[ -n "$keys" ] || { echo "github.com/${github} has no public ssh keys" >&2; exit 1; }
sudo install -d -m 700 -o ${user} -g ${user} /home/${user}/.ssh
{ printf '%s\\n' "# from github.com/${github}.keys, refreshed by cast hosts provision --add-user; your own additions go in authorized_keys.local" "$keys"
  sudo cat /home/${user}/.ssh/authorized_keys.local 2>/dev/null || true; } | sudo tee /home/${user}/.ssh/authorized_keys.codecast >/dev/null
sudo chown ${user}:${user} /home/${user}/.ssh/authorized_keys.codecast && sudo chmod 600 /home/${user}/.ssh/authorized_keys.codecast
sudo mv -f /home/${user}/.ssh/authorized_keys.codecast /home/${user}/.ssh/authorized_keys
echo "keys=$(printf '%s\\n' "$keys" | grep -c .)"`
    : `echo keys=unchanged`;
  return `set -euo pipefail
[ -e ${SHARED_HOST_MARKER} ] || { echo "not a shared host: provision it with --shared first" >&2; exit 1; }
if ! id -u ${user} >/dev/null 2>&1; then sudo adduser --disabled-password --gecos '' --shell /bin/bash ${user} >/dev/null; fi
[ "$(getent passwd ${user} | cut -d: -f6)" = /home/${user} ] || { echo "${user}'s home is not /home/${user}" >&2; exit 1; }
sudo install -d -m 700 -o ${user} -g ${user} /home/${user}/.codecast
${keys}
echo ADD-USER-ROOT-OK`;
}

/**
 * The person's own toolchain, as that person: bun, the published cast, the
 * agent CLIs and node at the provisioning laptop's versions, their PATH line,
 * and Claude's first-run screens. The PATH leaves /usr/local/bin out, so a
 * tool the provisioning user linked there is never mistaken for one this
 * person already has.
 */
export function addUserSelfScript(versions: Parameters<typeof agentCliInstallScript>[0]): string {
  const ownPath = 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.grok/bin:$HOME/.opencode/bin:/usr/bin:/bin"';
  const agents = agentCliInstallScript(versions).replace(/^export PATH=.*$/m, ownPath);
  return `set -euo pipefail
cd "$HOME"
${ownPath}
[ -x "$HOME/.bun/bin/bun" ] || (curl -fsSL https://bun.sh/install | bash) >/dev/null 2>&1
"$HOME/.bun/bin/bun" --version >/dev/null
(
${hostReleaseScript("linux", false)}
)
${agents}
${bashrcPathScript()}
${claudeFirstRunScript()}
echo ADD-USER-SELF-OK`;
}

/** Turn on the person's daemon: it starts as soon as their `cast login` lands. */
export function enableUserDaemonScript(user: string): string {
  if (!isLinuxUserName(user)) throw new Error(`not a Linux user name: ${user}`);
  return `set -euo pipefail
sudo systemctl enable --now ${USER_DAEMON_UNIT}${user}.path
printf 'path=%s daemon=%s\\n' "$(systemctl is-active ${USER_DAEMON_UNIT}${user}.path)" "$(systemctl is-active ${USER_DAEMON_UNIT}${user}.service || true)"`;
}

/** What the person runs on the host to finish: their own Claude, then their own codecast. */
export function teammateSteps(user: string, address: string): string[] {
  return [
    `ssh ${user}@${address}`,
    "claude setup-token        # open the URL it prints, sign in with YOUR Claude account, copy the sk-ant-oat token",
    `read -rsp 'Claude token: ' t && (umask 077; printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\\n' "$t" > ~/.codecast/claude.env); echo`,
    "cast login <token>         # codecast → Settings → CLI → Generate token; the daemon starts on its own",
  ];
}

/** The same, for the host's own login: its daemon already runs, so it restarts onto the token. */
export function sharedOwnerSteps(user: string, address: string): string[] {
  return [...teammateSteps(user, address).slice(0, 3), "sudo systemctl restart codecast-daemon.service"];
}
