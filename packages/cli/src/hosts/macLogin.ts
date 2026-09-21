import { execFileSync } from "../proc.js";
import { sshBase, type RemoteHost } from "../remote/session-move.js";

export function macLoginScript(user: string): string {
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(user)) throw new Error("Service username must start with a lowercase letter and contain only letters, digits, dashes or underscores");
  return `set -euo pipefail
[ "$(uname -s)" = Darwin ]
sudo -n true
service_user='${user}'
service_home='/Users/${user}'
marker="$service_home/.codecast-managed-login"
if dscl . -read "/Users/$service_user" >/dev/null 2>&1; then
  sudo test -f "$marker" || { echo 'That login already exists and is not managed by Codecast; choose another service username' >&2; exit 1; }
else
  [ -s "$HOME/.ssh/authorized_keys" ] || { echo 'The bootstrap login has no SSH authorized_keys to carry to the service login' >&2; exit 1; }
  next_uid=501
  while dscl . -search /Users UniqueID "$next_uid" | grep -q .; do next_uid=$((next_uid + 1)); done
  sudo dscl . -create "/Users/$service_user"
  sudo dscl . -create "/Users/$service_user" UniqueID "$next_uid"
  sudo dscl . -create "/Users/$service_user" PrimaryGroupID 20
  sudo dscl . -create "/Users/$service_user" NFSHomeDirectory "$service_home"
  sudo dscl . -create "/Users/$service_user" UserShell /bin/zsh
  sudo dscl . -create "/Users/$service_user" RealName 'Codecast remote service'
  sudo dscl . -create "/Users/$service_user" Password '*'
  sudo mkdir -p "$service_home/.ssh"
  sudo cp "$HOME/.ssh/authorized_keys" "$service_home/.ssh/authorized_keys"
  sudo chmod 700 "$service_home/.ssh"
  sudo chmod 600 "$service_home/.ssh/authorized_keys"
  sudo touch "$marker"
  sudo chown -R "$service_user:staff" "$service_home"
fi
sudo mkdir -p /private/etc/sudoers.d
rule=$(mktemp)
printf '%s ALL=(ALL) NOPASSWD: ALL\\n' "$service_user" > "$rule"
sudo visudo -cf "$rule"
sudo install -o root -g wheel -m 440 "$rule" "/private/etc/sudoers.d/codecast-$service_user"
rm "$rule"
sudo -H -u "$service_user" sudo -n true
echo MAC-LOGIN-OK`;
}

export function provisionMacLogin(host: RemoteHost, user: string): RemoteHost {
  if (user === host.user) return host;
  const output = execFileSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, "bash -s"], {
    input: macLoginScript(user), encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  });
  if (!output.includes("MAC-LOGIN-OK")) throw new Error("Mac service login setup did not finish");
  return { ...host, user, homeDir: `/Users/${user}`, remoteBaseDir: `/Users/${user}/work` };
}
