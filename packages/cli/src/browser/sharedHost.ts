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
import { REMOTE_BUNDLE_DIR } from "./castBundle.js";
import { agentCliInstallScript } from "./provisionAgents.js";
import { SHARED_HOST_MARKER } from "../remote/sharedHostGuard.js";
import { DAEMON_WANTED_FILE } from "../systemdDaemonUnit.js";
import { isLinuxUserName } from "@codecast/shared/contracts/teamHosts";

export { isLinuxUserName };

export const USER_DAEMON_UNIT = "codecast-daemon-user@";

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
 * starts it, so nobody but the admin needs sudo. Both key on a file the person
 * owns, ~/.codecast/daemon.wanted: `cast login` and `cast start` create it and
 * the path unit starts the daemon; `cast stop` removes it, and the service's
 * ExecCondition then keeps Restart= from reviving the daemon. Peer mode: no
 * CODECAST_REMOTE_DEVICE, and a Claude token the person puts in
 * ~/.codecast/claude.env reaches their sessions.
 */
export function userDaemonUnits(): { service: string; path: string } {
  return {
    service: `[Unit]
Description=codecast daemon for %i (shared host)
After=network-online.target
Wants=network-online.target
ConditionPathExists=/home/%i/.codecast/config.json
[Service]
# Checked before every start, Restart= ones included (a Condition= is not):
# without the wanted file the daemon stays down after \`cast stop\`.
ExecCondition=/usr/bin/test -e /home/%i/.codecast/${DAEMON_WANTED_FILE}
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
Description=start the codecast daemon for %i while they want it running
[Path]
PathExists=/home/%i/.codecast/${DAEMON_WANTED_FILE}
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
${markerAdminScript()}
${bashrcPathScript()}
echo SHARED-MARK-OK`;
}

/**
 * The marker, naming the provisioning user as the box's admin: its only
 * sudoer, so the one home on the box no one else can read, and the one the
 * push guard lets laptop logins into. Keeps a registered machine's other lines.
 */
function markerAdminScript(): string {
  return `sudo install -d -m 755 /etc/codecast
sudo touch ${SHARED_HOST_MARKER}
if ! grep -qx "admin=$(id -un)" ${SHARED_HOST_MARKER}; then
  { grep -v '^admin=' ${SHARED_HOST_MARKER} || true; echo "admin=$(id -un)"; } | sudo tee ${SHARED_HOST_MARKER}.new >/dev/null
  sudo chmod 644 ${SHARED_HOST_MARKER}.new && sudo mv -f ${SHARED_HOST_MARKER}.new ${SHARED_HOST_MARKER}
fi`;
}

/**
 * Make the host shared, as its provisioning user. Idempotent. Writes the
 * marker and the per-user units, gives the owner the same PATH line every
 * user gets, answers the owner's Claude first-run screens, and removes every
 * /usr/local/bin link into a home directory: homes are 750 on Ubuntu, so such
 * a link is "permission denied" (systemd 203/EXEC) for everyone but its
 * owner. Each user runs their own copies from their own PATH instead.
 * Everyone already signed in gets the wanted file, so the new units keep
 * running their daemons.
 */
export function sharedHostSetupScript(): string {
  const units = userDaemonUnits();
  return `set -euo pipefail
${markerAdminScript()}
for cfg in /home/*/.codecast/config.json; do
  [ -e "$cfg" ] || continue
  u=$(stat -c %U "$cfg"); w="$(dirname "$cfg")/${DAEMON_WANTED_FILE}"
  [ -e "$w" ] || { sudo install -m 600 -o "$u" -g "$(id -gn "$u")" /dev/null "$w" && echo "wanted $u"; }
done
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
 * re-read on every run, so re-running is how keys refresh. Keys come from
 * github.com/<login>.keys, the `pubkey` given (a laptop joining from the CLI),
 * and their own ~/.ssh/authorized_keys.local. `lenientKeys`: a GitHub account
 * with no keys is not an error (a join from the web, where ssh is optional).
 * No sudo for them: their daemon starts through the path unit.
 */
export function addUserRootScript(user: string, github?: string, opts: { pubkey?: string; lenientKeys?: boolean } = {}): string {
  if (!isLinuxUserName(user)) throw new Error(`not a Linux user name: ${user}`);
  if (github !== undefined && !isGitHubLogin(github)) throw new Error(`not a GitHub login: ${github}`);
  if (opts.pubkey !== undefined && !/^[A-Za-z0-9@.+/= _-]{20,800}$/.test(opts.pubkey)) throw new Error("not an ssh public key");
  const fetchKeys = github
    ? `keys=$(curl -fsS --max-time 15 https://github.com/${github}.keys || true)
${opts.lenientKeys ? "" : `[ -n "$keys" ] || { echo "github.com/${github} has no public ssh keys" >&2; exit 1; }\n`}`
    : "keys=\n";
  const pubkey = opts.pubkey ? `keys=$(printf '%s\\n%s' "$keys" '${opts.pubkey}')\n` : "";
  const keys = github || opts.pubkey
    ? `${fetchKeys}${pubkey}sudo install -d -m 700 -o ${user} -g ${user} /home/${user}/.ssh
{ printf '%s\\n' "# from ${github ? `github.com/${github}.keys` : "codecast"}${opts.pubkey ? " and the joining laptop" : ""}, refreshed on every join or --add-user; your own additions go in authorized_keys.local" "$keys"
  sudo cat /home/${user}/.ssh/authorized_keys.local 2>/dev/null || true; } | sudo tee /home/${user}/.ssh/authorized_keys.codecast >/dev/null
sudo chown ${user}:${user} /home/${user}/.ssh/authorized_keys.codecast && sudo chmod 600 /home/${user}/.ssh/authorized_keys.codecast
sudo mv -f /home/${user}/.ssh/authorized_keys.codecast /home/${user}/.ssh/authorized_keys
echo "keys=$(printf '%s\\n' "$keys" | grep -c . || true)"`
    : `echo keys=unchanged`;
  return `set -euo pipefail
[ -e ${SHARED_HOST_MARKER} ] || { echo "not a shared host: provision it with --shared first" >&2; exit 1; }
if ! id -u ${user} >/dev/null 2>&1; then sudo adduser --disabled-password --gecos '' --shell /bin/bash ${user} >/dev/null; fi
[ "$(getent passwd ${user} | cut -d: -f6)" = /home/${user} ] || { echo "${user}'s home is not /home/${user}" >&2; exit 1; }
sudo usermod -U -e '' ${user} 2>/dev/null || true
sudo install -d -m 700 -o ${user} -g ${user} /home/${user}/.codecast
${keys}
echo ADD-USER-ROOT-OK`;
}

/**
 * Take a person off the box, as root: their daemon and every process of
 * theirs stop and stay off, their login is locked, and their home is kept (their worktrees are theirs to
 * reclaim; only the admin deletes files, by hand).
 */
export function removeUserRootScript(user: string): string {
  if (!isLinuxUserName(user)) throw new Error(`not a Linux user name: ${user}`);
  return `set -euo pipefail
sudo rm -f /home/${user}/.codecast/${DAEMON_WANTED_FILE}
sudo systemctl disable --now ${USER_DAEMON_UNIT}${user}.path 2>/dev/null || true
sudo systemctl stop ${USER_DAEMON_UNIT}${user}.service 2>/dev/null || true
# Their sessions too: a removed member's tmux and agents would keep spending the box.
sudo pkill -KILL -u ${user} 2>/dev/null || true
sudo usermod -L -e 1 ${user} 2>/dev/null || true
sudo rm -f /home/${user}/.codecast/config.json /home/${user}/.ssh/authorized_keys
echo REMOVE-USER-OK`;
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
# One cast on the box: the admin's bundle when the box runs one (provisioned
# from source), on this person's own bun, so they follow its updates;
# otherwise the published release.
if [ -f ${REMOTE_BUNDLE_DIR}/index.js ]; then
  mkdir -p "$HOME/.local/bin"
  printf '#!/usr/bin/env bash\\nexec "$HOME/.bun/bin/bun" ${REMOTE_BUNDLE_DIR}/index.js "$@"\\n' > "$HOME/.local/bin/cast.next"
  chmod 755 "$HOME/.local/bin/cast.next" && mv -f "$HOME/.local/bin/cast.next" "$HOME/.local/bin/cast"
else
(
${hostReleaseScript("linux", false)}
)
fi
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
