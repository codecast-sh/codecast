import { randomBytes } from "node:crypto";
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

/** XOR key macOS loginwindow uses to read /etc/kcpassword at boot. */
const KCPASSWORD_KEY = [0x7d, 0x89, 0x52, 0x23, 0xd2, 0xbc, 0xdd, 0xea, 0xa3, 0xb9, 0x1f];

/** The /etc/kcpassword bytes for a password: NUL-terminated, padded to a
 *  multiple of 12 (macOS 13+ rejects other lengths), XORed with the key. */
export function kcpassword(password: string): Buffer {
  const plain = Buffer.from(`${password}\0`, "utf8");
  const out = Buffer.alloc(Math.ceil(plain.length / 12) * 12);
  plain.copy(out);
  for (let i = 0; i < out.length; i++) out[i] ^= KCPASSWORD_KEY[i % KCPASSWORD_KEY.length];
  return out;
}

export type MacDesktop = "live" | "at-boot" | "password-unknown";

/**
 * Make the login sessions run as the Mac's desktop: the console session
 * loginwindow starts at boot. `cast computer` drives apps only inside a
 * desktop session and a headed browser paints only there, so a session login
 * with none has neither. Autologin needs the login's password in
 * /etc/kcpassword, so this sets one only where nobody else holds it: a login
 * Codecast created, or one with no password at all. A login with a password
 * of its own is left alone and reported.
 */
export function macDesktopScript(user: string, password = randomBytes(18).toString("base64url")): string {
  if (!/^[a-zA-Z_][\w-]*$/.test(user)) throw new Error("unsupported Mac username");
  if (!/^[\w-]+$/.test(password)) throw new Error("unsupported desktop password");
  return `set -euo pipefail
sudo -n true
user='${user}'
uid=$(id -u "$user")
current=$(sudo defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)
if [ "$current" != "$user" ]; then
  if dscl . -read "/Users/$user" AuthenticationAuthority 2>/dev/null | grep -q ShadowHash && ! sudo test -f "/Users/$user/.codecast-managed-login"; then
    echo MAC-DESKTOP-PASSWORD-UNKNOWN; exit 0
  fi
  sudo dscl . -passwd "/Users/$user" '${password}'
  echo '${kcpassword(password).toString("base64")}' | base64 -D | sudo tee /etc/kcpassword >/dev/null
  sudo chown root:wheel /etc/kcpassword
  sudo chmod 600 /etc/kcpassword
  sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser "$user"
  [ -z "$current" ] || echo "MAC-DESKTOP-PREVIOUS $current"
fi
sudo -H -u "$user" defaults -currentHost write com.apple.screensaver idleTime -int 0
sudo pmset -a sleep 0 displaysleep 0
if sudo launchctl print "gui/$uid" >/dev/null 2>&1; then echo MAC-DESKTOP-LIVE; else echo MAC-DESKTOP-AT-BOOT; fi`;
}

export function parseMacDesktop(output: string): { desktop: MacDesktop; previous: string | null } {
  const previous = /^MAC-DESKTOP-PREVIOUS (\S+)$/m.exec(output)?.[1] ?? null;
  if (output.includes("MAC-DESKTOP-LIVE")) return { desktop: "live", previous };
  if (output.includes("MAC-DESKTOP-AT-BOOT")) return { desktop: "at-boot", previous };
  if (output.includes("MAC-DESKTOP-PASSWORD-UNKNOWN")) return { desktop: "password-unknown", previous };
  throw new Error(`Mac desktop setup did not finish: ${output.slice(-600)}`);
}
