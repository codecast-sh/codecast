import { randomBytes } from "node:crypto";
import { execFileSync } from "../proc.js";
import { sshBase, type RemoteHost } from "../remote/session-move.js";
import { HELPER_APP_BASENAME } from "../computer/helperApp.js";

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
  next_uid=501
  while dscl . -search /Users UniqueID "$next_uid" | grep -q .; do next_uid=$((next_uid + 1)); done
  sudo dscl . -create "/Users/$service_user"
  sudo dscl . -create "/Users/$service_user" UniqueID "$next_uid"
  sudo dscl . -create "/Users/$service_user" PrimaryGroupID 20
  sudo dscl . -create "/Users/$service_user" NFSHomeDirectory "$service_home"
  sudo dscl . -create "/Users/$service_user" UserShell /bin/zsh
  sudo dscl . -create "/Users/$service_user" RealName 'Codecast remote service'
  sudo dscl . -create "/Users/$service_user" Password '*'
  sudo mkdir -p "$service_home"
  sudo touch "$marker"
  sudo chown -R "$service_user:staff" "$service_home"
fi
# The codecast base image ships this login with no keys: each host's own
# launch key, which AWS gives the bootstrap login, is the way in.
if ! sudo test -s "$service_home/.ssh/authorized_keys"; then
  [ -s "$HOME/.ssh/authorized_keys" ] || { echo 'The bootstrap login has no SSH authorized_keys to carry to the service login' >&2; exit 1; }
  sudo mkdir -p "$service_home/.ssh"
  sudo cp "$HOME/.ssh/authorized_keys" "$service_home/.ssh/authorized_keys"
  sudo chmod 700 "$service_home/.ssh"
  sudo chmod 600 "$service_home/.ssh/authorized_keys"
  sudo chown -R "$service_user:staff" "$service_home/.ssh"
fi
sudo mkdir -p /private/etc/sudoers.d
rule=$(mktemp)
printf '%s ALL=(ALL) NOPASSWD: ALL\\n' "$service_user" > "$rule"
sudo visudo -cf "$rule"
sudo install -o root -g wheel -m 440 "$rule" "/private/etc/sudoers.d/codecast-$service_user"
rm "$rule"
# It already holds passwordless sudo; admin lets its own password approve
# the Privacy & Security toggles on its desktop.
sudo dseditgroup -o edit -a "$service_user" -t user admin
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

/** The first-login Setup Assistant panes a login is marked as having seen, so
 *  none of them sits over the screen when it is signed in unattended. */
const SETUP_ASSISTANT_SEEN = [
  "DidSeeCloudSetup", "DidSeePrivacy", "DidSeeSiriSetup", "DidSeeTouchIDSetup", "DidSeeScreenTime", "DidSeeAppearanceSetup",
  "DidSeeAccessibility", "DidSeeActivationLock", "DidSeeTermsOfAddress", "DidSeeIntelligence", "DidSeeApplePaySetup",
  "DidSeeAvatarSetup", "DidSeeLockdownMode", "DidSeeTrueTone", "DidSeeiCloudLoginForStorageServices", "DidSeeSyncSetup",
  "DidSeeSyncSetup2", "DidSeeWalletSetup", "DidSeeUpdateCompleted", "DidSeeFileVault", "DidSeeSoftwareUpdate",
  "SkipFirstLoginOptimization",
];

/**
 * macOS 15 re-asks every month whether a screen-capturing app may keep
 * bypassing the window picker, and until someone answers, the helper's
 * screenshots stop. replayd keeps the next ask per app in this plist; a date
 * far ahead keeps an unattended desktop from ever being asked.
 */
const SCREEN_CAPTURE_APPROVAL = `import datetime, os, plistlib, sys
path, key = sys.argv[1], sys.argv[2]
try:
    data = plistlib.load(open(path, "rb"))
except (FileNotFoundError, plistlib.InvalidFileException):
    data = {}
far = datetime.datetime(2100, 1, 1, tzinfo=datetime.timezone.utc)
entry = data.get(key, {})
entry.update({"kScreenCapturePrivacyHintDate": far, "kScreenCapturePrivacyHintPolicy": 2592000, "kScreenCaptureApprovalLastAlerted": far, "kScreenCaptureApprovalLastUsed": far})
data[key] = entry
os.makedirs(os.path.dirname(path), exist_ok=True)
plistlib.dump(data, open(path, "wb"))`;

export type MacDesktop = "live" | "at-boot" | "password-unknown";

/**
 * Make the login sessions run as the Mac's desktop: the console session
 * loginwindow starts at boot. `cast computer` drives apps only inside a
 * desktop session and a headed browser paints only there, so a session login
 * with none has neither. Autologin needs the login's password in
 * /etc/kcpassword, so this sets one only where nobody else holds it: a login
 * Codecast created, or one with no password at all. A login with a password
 * of its own is left alone and reported.
 *
 * The password Codecast sets is kept in the login's own
 * ~/.codecast/desktop-password, because the one step macOS reserves for a
 * person (switching on the helper's Accessibility and Screen Recording, on a
 * machine that never had them) is done over Screen Sharing as this login.
 * The rest keeps the desktop usable unattended: no first-login Setup
 * Assistant over the screen, no screen lock, and no relock when a Screen
 * Sharing viewer disconnects.
 */
export function macDesktopScript(user: string, password = randomBytes(18).toString("base64url")): string {
  if (!/^[a-zA-Z_][\w-]*$/.test(user)) throw new Error("unsupported Mac username");
  if (!/^[\w-]+$/.test(password)) throw new Error("unsupported desktop password");
  return `set -euo pipefail
sudo -n true
user='${user}'
uid=$(id -u "$user")
pwfile="/Users/$user/.codecast/desktop-password"
current=$(sudo defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)
managed=$(sudo test -f "/Users/$user/.codecast-managed-login" && echo yes || true)
# A managed login without its password file came from the public base image,
# whose password anyone can read out of it: every host sets its own.
if [ "$current" != "$user" ] || { [ -n "$managed" ] && ! sudo test -s "$pwfile"; }; then
  if dscl . -read "/Users/$user" AuthenticationAuthority 2>/dev/null | grep -q ShadowHash && [ -z "$managed" ]; then
    echo MAC-DESKTOP-PASSWORD-UNKNOWN; exit 0
  fi
  old=""
  if [ "$current" = "$user" ]; then
    old=$(sudo python3 -c 'k=[${KCPASSWORD_KEY.join(",")}];b=open("/etc/kcpassword","rb").read();print(bytes(x^k[i%11] for i,x in enumerate(b)).split(b"\\0")[0].decode())' 2>/dev/null || true)
  fi
  sudo dscl . -passwd "/Users/$user" '${password}'
  # The login keychain still opens with the old password; without this the
  # next boot greets the desktop with a keychain prompt nobody answers.
  [ -z "$old" ] || sudo -H -u "$user" security set-keychain-password -o "$old" -p '${password}' "/Users/$user/Library/Keychains/login.keychain-db" >/dev/null 2>&1 || true
  echo '${kcpassword(password).toString("base64")}' | base64 -D | sudo tee /etc/kcpassword >/dev/null
  sudo chown root:wheel /etc/kcpassword
  sudo chmod 600 /etc/kcpassword
  sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser "$user"
  sudo -H -u "$user" mkdir -p "/Users/$user/.codecast"
  printf '%s' '${password}' | sudo -H -u "$user" tee "$pwfile" >/dev/null
  sudo chmod 600 "$pwfile"
  [ -z "$current" ] || echo "MAC-DESKTOP-PREVIOUS $current"
fi
ver=$(sw_vers -productVersion); build=$(sw_vers -buildVersion)
for key in ${SETUP_ASSISTANT_SEEN.join(" ")}; do
  sudo -H -u "$user" defaults write com.apple.SetupAssistant "$key" -bool true
done
for key in LastSeenCloudProductVersion LastPreLoginTasksPerformedVersion; do sudo -H -u "$user" defaults write com.apple.SetupAssistant "$key" "$ver"; done
for key in LastSeenBuddyBuildVersion LastPreLoginTasksPerformedBuild; do sudo -H -u "$user" defaults write com.apple.SetupAssistant "$key" "$build"; done
sudo -H -u "$user" defaults write com.apple.SetupAssistant LastPrivacyBundleVersion 9999
sudo -H -u "$user" defaults -currentHost write com.apple.screensaver idleTime -int 0
sudo -H -u "$user" python3 - "/Users/$user/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist" "file://$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "/Users/$user/.codecast/computer/${HELPER_APP_BASENAME}/")" <<'PY'
${SCREEN_CAPTURE_APPROVAL}
PY
sudo pmset -a sleep 0 displaysleep 0
sudo defaults write /Library/Preferences/com.apple.RemoteManagement RestoreMachineState -bool NO
sudo dseditgroup -o edit -a "$user" -t user com.apple.access_screensharing >/dev/null 2>&1 || true
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart -configure -access -on -users "$user" -privs -all >/dev/null 2>&1 || true
if sudo launchctl print "gui/$uid" >/dev/null 2>&1; then
  # Takes the login's password and its desktop session, so it waits for both.
  pw=$(sudo cat "$pwfile" 2>/dev/null || true)
  [ -z "$pw" ] || sudo launchctl asuser "$uid" sudo -H -u "$user" sysadminctl -screenLock off -password "$pw" >/dev/null 2>&1 || true
  echo MAC-DESKTOP-LIVE
else
  echo MAC-DESKTOP-AT-BOOT
fi`;
}

export function parseMacDesktop(output: string): { desktop: MacDesktop; previous: string | null } {
  const previous = /^MAC-DESKTOP-PREVIOUS (\S+)$/m.exec(output)?.[1] ?? null;
  if (output.includes("MAC-DESKTOP-LIVE")) return { desktop: "live", previous };
  if (output.includes("MAC-DESKTOP-AT-BOOT")) return { desktop: "at-boot", previous };
  if (output.includes("MAC-DESKTOP-PASSWORD-UNKNOWN")) return { desktop: "password-unknown", previous };
  throw new Error(`Mac desktop setup did not finish: ${output.slice(-600)}`);
}
