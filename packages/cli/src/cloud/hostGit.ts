/**
 * Git push access FROM the cloud host: the laptop-driven step that makes the
 * host push on its own.
 *
 * Two credentials can do it. The codecast GitHub App is already installed on
 * the repositories these sessions work in, and an installation token pushes
 * over https, so a host whose owner has that installation needs no human step
 * at all: `cast git-credential` asks the server for a token per git operation.
 * The host's own device key (gitIdentity.ts, published through the heartbeat
 * and granted on GitHub through the devices page or `cast hosts key`) is the
 * fallback, and the one a repository outside any installation still needs.
 *
 * So `ensureHostGitReady` runs ONE idempotent script over ssh that
 *
 *   1. pins GitHub's published host keys into ~/.ssh/known_hosts (a stale pin
 *      fails closed — the laptop fallback in transfer.ts still works),
 *   2. writes a marker-fenced `Host <remote>` block in ~/.ssh/config pointing
 *      at the device key, `IdentitiesOnly yes` once that key is proven to push
 *      (so forwarded laptop agent keys can no longer exhaust MaxAuthTries),
 *   3. mints the device key eagerly at gitIdentity.ts's exact path — instead
 *      of waiting for the first failed fetch — so the grant can happen before
 *      any session runs there,
 *   4. mirrors the laptop's user.name/user.email (+ push.autoSetupRemote) into
 *      the host's ~/.gitconfig, or writes the `codecast <codecast@local>`
 *      placeholder when there is nothing to mirror (never git's auto identity,
 *      which leaks the box's internal hostname through every commit),
 *   5. points github.com's credential helper at `cast git-credential` in the
 *      host's ~/.gitconfig (other helpers left alone) and turns on
 *      `useHttpPath`, without which git names no repository and the helper
 *      cannot tell which installation to ask for,
 *   6. probes READ and WRITE access separately: `git ls-remote` alone only
 *      exercises upload-pack, so a deploy key added with GitHub's default
 *      read-only setting would report granted while every push failed;
 *      `--upload-pack=git-receive-pack` needs no checkout and answers that.
 *      The App path is probed on its own https origin: the helper is asked for
 *      the repository, and a fetch proves the token git received works.
 *
 * The write probe over https deliberately does NOT use
 * `--upload-pack=git-receive-pack` (smart HTTP ignores it, see gitOrigin.ts):
 * the server decides the App path's push right instead, refusing to mint a
 * token whose contents permission is not write, so a helper that answered has
 * push access by construction.
 *
 * Everything resolves from $HOME on the host and the script is delivered as
 * `bash -c "$(cat)"` with `exec </dev/null`, so nothing it runs (ssh-keygen's
 * "Overwrite?" prompt included) can read the rest of the script as input.
 */

import { spawnSync } from "../proc.js";
import { DEVICE_GIT_KEY_REL, deviceKeyComment, isGitAuthError } from "../gitIdentity.js";
import { shq, sshBase, type RemoteHost } from "../remote/session-move.js";
import { githubRepo, hostAppOrigin, hostProbeOrigin, isGitHubHost, originHost } from "./gitOrigin.js";

export { DEVICE_GIT_KEY_REL as DEVICE_KEY_REL } from "../gitIdentity.js";

/**
 * GitHub's published SSH host keys, verbatim from
 * https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
 * (re-checked against `ssh-keyscan github.com` on 2026-09-06; last rotation:
 * RSA, March 2023). A wrong pin fails closed: the host's fetch errors and
 * the laptop transfer path takes over.
 */
export const GITHUB_KNOWN_HOSTS: readonly string[] = [
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
];

export const SSH_CONFIG_BLOCK_START = "# >>> codecast git >>>";
export const SSH_CONFIG_BLOCK_END = "# <<< codecast git <<<";
export const PLACEHOLDER_NAME = "codecast";
export const PLACEHOLDER_EMAIL = "codecast@local";

// ---------------------------------------------------------------------------
// Origin parsing
// ---------------------------------------------------------------------------

// The rules live in gitOrigin.ts, a leaf `cast git-credential` can load
// without the ssh plumbing; re-exported here because every caller already
// imports them from this module.
export {
  ACCOUNT_KEY_URL, deployKeyUrl, githubRepo, hostAppOrigin, hostProbeOrigin,
  isGitHubHost, originHost, parseOrigin,
} from "./gitOrigin.js";

// ---------------------------------------------------------------------------
// Laptop-side inputs
// ---------------------------------------------------------------------------

function gitOut(args: string[], cwd?: string): string | undefined {
  const r = spawnSync("git", args, { encoding: "utf-8", stdio: "pipe", timeout: 15_000, ...(cwd ? { cwd } : {}), env: process.env });
  if (r.error || r.status !== 0) return undefined;
  const out = r.stdout.trim();
  return out || undefined;
}

/** Parse `--git-identity "Name <email>"`. */
export function parseIdentityOverride(value: string | undefined): { name?: string; email?: string } {
  if (!value) return {};
  const m = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  if (m) return { name: m[1] || undefined, email: m[2] };
  return { name: value.trim() || undefined };
}

/**
 * The identity a commit on the host should carry: the explicit override,
 * else the repo being prepared (so an `includeIf gitdir:` profile resolves),
 * else the laptop's global config. Either half may be missing.
 */
export function laptopIdentity(localGitRoot?: string, override?: string): { name?: string; email?: string } {
  const o = parseIdentityOverride(override);
  if (o.name && o.email) return o;
  const fromRepo = localGitRoot
    ? { name: gitOut(["-C", localGitRoot, "config", "--get", "user.name"]), email: gitOut(["-C", localGitRoot, "config", "--get", "user.email"]) }
    : { name: undefined, email: undefined };
  const fromGlobal = { name: gitOut(["config", "--global", "--get", "user.name"]), email: gitOut(["config", "--global", "--get", "user.email"]) };
  return {
    name: o.name ?? fromRepo.name ?? fromGlobal.name,
    email: o.email ?? fromRepo.email ?? fromGlobal.email,
  };
}

/**
 * The laptop's known_hosts lines for a host (`ssh-keygen -F`), comment lines
 * dropped. `file` names the known_hosts to read (tests): ssh-keygen resolves
 * `~` through the password database, not $HOME, so a redirected HOME alone
 * does not reach it.
 */
export function laptopKnownHostLines(host: string, file?: string): string[] {
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return [];
  const r = spawnSync("ssh-keygen", ["-F", host, ...(file ? ["-f", file] : [])], { encoding: "utf-8", stdio: "pipe", timeout: 10_000 });
  if (r.error || r.status !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

/** The known_hosts lines to pin for an origin host: GitHub's published keys, else whatever the laptop trusts. */
export function knownHostLinesFor(host: string, laptopFile?: string): { lines: string[]; source: "pinned" | "laptop" | "none" } {
  if (isGitHubHost(host)) return { lines: [...GITHUB_KNOWN_HOSTS], source: "pinned" };
  const lines = laptopKnownHostLines(host, laptopFile);
  return { lines, source: lines.length ? "laptop" : "none" };
}

// ---------------------------------------------------------------------------
// The host script
// ---------------------------------------------------------------------------

export interface HostGitScriptOptions {
  knownHostLines: string[];
  sshHost: string;
  identity: { name?: string; email?: string } | undefined;
  keyComment: string;
  identitiesOnly: boolean;
  repoPath?: string;
  /** The origin to probe; absent = no probes (nothing to probe against). */
  origin?: string;
  /** The https origin of the same repository, probed through `cast git-credential`; absent = not a GitHub repo. */
  appOrigin?: string;
  /** How long to wait for ~/.codecast/mirror.lock before proceeding unlocked (default 60; tests shorten it). */
  lockWaitSeconds?: number;
}

/** The verb the helper value names. fastPath.ts claims the same word, so git's
 *  invocation of it never enters the CLI lifecycle (gitCredential.ts). */
export const CREDENTIAL_HELPER_VERB = "git-credential";
/** The github.com credential config the host keeps, as `git config` keys. */
export const CREDENTIAL_HELPER_KEY = "credential.https://github.com.helper";
export const CREDENTIAL_USE_PATH_KEY = "credential.https://github.com.useHttpPath";
/**
 * Which helper values are OURS, as the regex `git config --unset-all` matches
 * against each value.
 *
 * It has to be anchored to the exact shape we write, `!<path to cast>
 * git-credential`, because git ships helpers whose own names contain the same
 * words: a bare `git-credential` pattern also matches
 * `/usr/lib/git-core/git-credential-libsecret` and `git-credential-manager`,
 * and a second run of this script would then delete the helper the human set
 * up rather than replacing its own.
 */
export const CREDENTIAL_HELPER_PATTERN = `^!.*cast ${CREDENTIAL_HELPER_VERB}$`;
/** An askPass that answers nothing, so a credential prompt fails instead of blocking. */
export const NO_ASKPASS = "/bin/true";

/** The ssh config block for one host, with the IdentitiesOnly value spelled out. */
export function sshConfigBlock(sshHost: string, identitiesOnly: boolean): string {
  return [
    SSH_CONFIG_BLOCK_START,
    `Host ${sshHost}`,
    `  IdentityFile ~/${DEVICE_GIT_KEY_REL}`,
    `  IdentitiesOnly ${identitiesOnly ? "yes" : "no"}`,
    "  BatchMode yes",
    "  AddKeysToAgent no",
    SSH_CONFIG_BLOCK_END,
  ].join("\n");
}

function assertSafe(value: string, what: string, re: RegExp): void {
  if (!re.test(value)) throw new Error(`${what} ${JSON.stringify(value)} is not safe for the host script`);
}

/**
 * The bash script run on the host. Idempotent; never exits non-zero for a
 * denied probe (that is an answer, printed in the JSON line); resolves every
 * path from $HOME so a test can redirect it completely.
 */
export function hostGitScript(opts: HostGitScriptOptions): string {
  assertSafe(opts.sshHost, "ssh host", /^[A-Za-z0-9.-]+$/);
  for (const l of opts.knownHostLines) assertSafe(l, "known_hosts line", /^[^\n\r\0]+$/);
  if (opts.repoPath) assertSafe(opts.repoPath, "repo path", /^\/[^\n\r\0]*$/);
  if (opts.origin) assertSafe(opts.origin, "origin", /^[^\s\0-][^\n\r\0]*$/);
  if (opts.appOrigin) assertSafe(opts.appOrigin, "app origin", /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+$/);
  const name = opts.identity?.name && opts.identity?.email ? opts.identity.name : "";
  const email = opts.identity?.name && opts.identity?.email ? opts.identity.email : "";
  // awk -v processes \n escapes, so the block travels as one -v value.
  const blockFor = (yes: boolean) => sshConfigBlock(opts.sshHost, yes).split("\n").join("\\n");
  const kh = opts.knownHostLines.length ? opts.knownHostLines.join("\n") + "\n" : "";
  return `set -u
umask 077
exec </dev/null
export GIT_TERMINAL_PROMPT=0
KEY="$HOME/${DEVICE_GIT_KEY_REL}"
SSH_DIR="$HOME/.ssh"
CFG="$SSH_DIR/config"
KH="$SSH_DIR/known_hosts"
GC="$HOME/.gitconfig"
ID_NAME=${shq(name)}
ID_EMAIL=${shq(email)}
REPO=${shq(opts.repoPath ?? "")}
ORIGIN=${shq(opts.origin ?? "")}
APP_ORIGIN=${shq(opts.appOrigin ?? "")}
# Appended, never prepended: the host's own PATH decides which git and which
# cast run; this only reaches the places an installer puts them.
export PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin"
mkdir -p "$SSH_DIR" && chmod 700 "$SSH_DIR"
# 1. known_hosts: append each pinned line only when it is not there yet.
[ -e "$KH" ] || : > "$KH"
chmod 600 "$KH"
while IFS= read -r line; do
  [ -n "$line" ] || continue
  grep -qxF -- "$line" "$KH" || printf '%s\\n' "$line" >> "$KH"
done <<'CAST_KNOWN_HOSTS'
${kh}CAST_KNOWN_HOSTS
# 2. the codecast block in ~/.ssh/config, replaced in place (appended when absent); other lines untouched.
write_block() {
  [ -e "$CFG" ] || : > "$CFG"
  tmp="$CFG.cast-tmp.$$"
  awk -v block="$1" 'BEGIN{skip=0;done=0} $0=="${SSH_CONFIG_BLOCK_START}"{print block;skip=1;done=1;next} $0=="${SSH_CONFIG_BLOCK_END}"{skip=0;next} !skip{print} END{if(!done)print block}' "$CFG" > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$CFG"
  chmod 600 "$CFG"
}
write_block '${blockFor(opts.identitiesOnly)}'
# 3. the device key, minted only when the .pub is absent. stdin is /dev/null,
#    so a concurrent mint by the host daemon (ssh-keygen's "Overwrite?" prompt)
#    answers itself with EOF, and the .pub is re-read either way.
mkdir -p "$(dirname "$KEY")" && chmod 700 "$(dirname "$KEY")"
if [ ! -f "$KEY.pub" ] && command -v ssh-keygen >/dev/null 2>&1; then
  ssh-keygen -t ed25519 -N '' -C ${shq(opts.keyComment)} -q -f "$KEY" </dev/null >/dev/null 2>&1 || true
fi
pubkey=""
[ -f "$KEY.pub" ] && pubkey=$(cat "$KEY.pub")
[ -f "$KEY" ] && chmod 600 "$KEY"
# 4. identity: mirrored from the laptop, else a global placeholder when the host has none.
#    ~/.gitconfig is co-written by the home mirror's apply, so the write runs
#    under the same ~/.codecast/mirror.lock (O_EXCL pid+token; a dead holder
#    or an unreadable lock older than 5s is broken; wait up to 60s).
LOCK="$HOME/.codecast/mirror.lock"
mkdir -p "$HOME/.codecast"
lock_token="hostgit-$$-$(date +%s)"
lock_deadline=$(( $(date +%s) + ${Number.isFinite(opts.lockWaitSeconds) ? Math.max(0, Math.floor(opts.lockWaitSeconds!)) : 60} ))
lock_held=0
while [ "$lock_held" = 0 ]; do
  if ( set -C; printf '{"pid":%s,"token":"%s","at":"%s"}' "$$" "$lock_token" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK" ) 2>/dev/null; then lock_held=1; break; fi
  # An unreadable lock (a directory, no permission) is judged by its mtime
  #  like an unparseable one; only a lock that vanished is retried at once.
  seen=$(cat "$LOCK" 2>/dev/null) || { [ -e "$LOCK" ] || continue; seen=""; }
  stale=0
  holder=\${seen#*'"pid":'}
  holder=\${holder#"\${holder%%[! ]*}"}
  holder=\${holder%%[!0-9]*}
  if [ -n "$holder" ]; then
    kill -0 "$holder" 2>/dev/null || stale=1
  else
    lock_mtime=$(stat -c %Y "$LOCK" 2>/dev/null || stat -f %m "$LOCK" 2>/dev/null || echo 0)
    [ $(( $(date +%s) - lock_mtime )) -gt 5 ] && stale=1
  fi
  if [ "$stale" = 1 ]; then
    [ "$(cat "$LOCK" 2>/dev/null)" = "$seen" ] && rm -f "$LOCK" 2>/dev/null
    [ -e "$LOCK" ] || continue
  fi
  [ "$(date +%s)" -ge "$lock_deadline" ] && break
  sleep 0.25
done
identity=kept
if [ -n "$ID_NAME" ] && [ -n "$ID_EMAIL" ]; then
  git config --file "$GC" user.name "$ID_NAME" && git config --file "$GC" user.email "$ID_EMAIL" && git config --file "$GC" push.autoSetupRemote true && identity=mirrored
elif [ -z "$(git config --file "$GC" --get user.email 2>/dev/null)" ]; then
  git config --file "$GC" user.name ${shq(PLACEHOLDER_NAME)} && git config --file "$GC" user.email ${shq(PLACEHOLDER_EMAIL)} && identity=placeholder
fi
# 5. github.com's credential helper: \`cast git-credential\` answers with a
#    GitHub App installation token. Written under the same lock as the
#    identity, because it is the same file. Ours is removed by value pattern
#    and re-added, so a re-run never stacks duplicates and any OTHER helper
#    the human configured keeps its place. useHttpPath is what makes git name
#    the repository, without which the helper cannot pick an installation.
CAST=$(command -v cast 2>/dev/null || true)
if [ -z "$CAST" ]; then for c in "$HOME/.local/bin/cast" "$HOME/.bun/bin/cast" /usr/local/bin/cast; do [ -x "$c" ] && CAST="$c" && break; done; fi
helper="!\${CAST:-cast} ${CREDENTIAL_HELPER_VERB}"
git config --file "$GC" --unset-all ${shq(CREDENTIAL_HELPER_KEY)} ${shq(CREDENTIAL_HELPER_PATTERN)} 2>/dev/null || true
git config --file "$GC" --add ${shq(CREDENTIAL_HELPER_KEY)} "$helper" 2>/dev/null || helper=""
git config --file "$GC" ${shq(CREDENTIAL_USE_PATH_KEY)} true 2>/dev/null || true
# Never prompt. An https origin whose helper has nothing to say makes git ask
# for a username, and in an agent's pane (a tty) that blocks the session
# forever; an askPass that answers nothing turns the hang into an ordinary
# authentication failure. Left alone when the host already has one. git has no
# per-url form of this key, so it reaches EVERY https remote on the host, not
# only github.com: nothing on the box can ask a human for a password after
# this, which is what we want on a machine with no human at it.
[ -n "$(git config --file "$GC" --get core.askPass 2>/dev/null)" ] || git config --file "$GC" core.askPass ${shq(NO_ASKPASS)} 2>/dev/null || true
[ -f "$GC" ] && chmod 600 "$GC"
if [ "$lock_held" = 1 ] && grep -q "$lock_token" "$LOCK" 2>/dev/null; then rm -f "$LOCK"; fi
if [ "$identity" = mirrored ] && [ -n "$REPO" ] && [ -e "$REPO/.git" ]; then
  if [ "$(git -C "$REPO" config --local --get user.email 2>/dev/null)" = ${shq(PLACEHOLDER_EMAIL)} ] && [ "$(git -C "$REPO" config --local --get user.name 2>/dev/null)" = ${shq(PLACEHOLDER_NAME)} ]; then
    git -C "$REPO" config --local --unset user.email; git -C "$REPO" config --local --unset user.name
  fi
fi
# 6. probes. First the device key, from $HOME with the key forced
#    (independent of any agent bridge), then the App token over https.
T=""; command -v timeout >/dev/null 2>&1 && T="timeout 30"
cd "$HOME" || true
read_rc=-1; write_rc=-1; read_err=""; write_err=""
if [ -n "$pubkey" ] && [ -n "$ORIGIN" ]; then
  export GIT_SSH_COMMAND="ssh -i '$KEY' -o IdentitiesOnly=yes -o BatchMode=yes"
  read_err=$($T git ls-remote --exit-code -- "$ORIGIN" HEAD 2>&1 >/dev/null); read_rc=$?
  write_err=$($T git ls-remote --upload-pack=git-receive-pack -- "$ORIGIN" 2>&1 >/dev/null); write_rc=$?
  unset GIT_SSH_COMMAND
fi
# The App path: ask the helper exactly what git will ask it, then fetch. The
# answer holds a token, so it is tested for shape and never printed.
app_cred=0; app_rc=-1; app_err=""
if [ -n "$APP_ORIGIN" ]; then
  app_host=\${APP_ORIGIN#https://}
  app_path=\${app_host#*/}
  app_host=\${app_host%%/*}
  answer=$(printf 'protocol=https\\nhost=%s\\npath=%s\\n\\n' "$app_host" "$app_path" | $T \${CAST:-cast} ${CREDENTIAL_HELPER_VERB} get 2>/dev/null || true)
  # git's own rule, so the probe cannot be more forgiving than git: the FIRST
  # line must be a key git knows, and a credential needs a password. Anything
  # printed ahead of it (an update notice, a warning) makes git throw the whole
  # answer away, and a probe that accepted it would report push access on a
  # host where every push fails.
  first=$(printf '%s\\n' "$answer" | head -n 1)
  case "$first" in username=*) case "$answer" in *password=*) app_cred=1 ;; esac ;; esac
  answer=""
  if [ "$app_cred" = 1 ]; then
    app_err=$($T git ls-remote --exit-code -- "$APP_ORIGIN" HEAD 2>&1 >/dev/null); app_rc=$?
  else
    app_err="cast git-credential returned no credential for $app_path"
  fi
fi
# 7. IdentitiesOnly follows the write probe: yes once the device key is proven
#    to push, no when a probe refused it. A run that probed nothing (no origin:
#    a wake, a provision outside a repo) keeps step 2's value — the registry's
#    last word — so a granted host is not flipped back to "no" by every wake.
if [ "$write_rc" = 0 ]; then write_block '${blockFor(true)}'; elif [ "$write_rc" != -1 ]; then write_block '${blockFor(false)}'; fi
b64() { printf '%s' "$1" | base64 | tr -d '\\n'; }
printf '{"v":1,"pubkey":"%s","identity":"%s","helper":"%s","read_rc":%s,"read_err":"%s","write_rc":%s,"write_err":"%s","app_cred":%s,"app_rc":%s,"app_err":"%s"}\\n' "$(b64 "$pubkey")" "$identity" "$(b64 "$helper")" "$read_rc" "$(b64 "$read_err")" "$write_rc" "$(b64 "$write_err")" "$app_cred" "$app_rc" "$(b64 "$app_err")"
exit 0
`;
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

export interface HostGitAccess {
  origin: string;
  read: boolean;
  write: boolean;
  /** The key is granted read-only (GitHub's default for a deploy key). */
  readonly?: boolean;
  /** The last stderr line of a failed probe. */
  error?: string;
}

/**
 * What a GitHub App installation token can do from the host, over https.
 *
 * `read` is a real fetch through the helper. `write` is the same fact: the
 * server refuses to mint a token whose contents permission is not write, so a
 * helper that answered at all holds a pushing credential. The https write
 * probe git offers (`--upload-pack=git-receive-pack`) cannot say this — smart
 * HTTP ignores the option and passes public repositories either way.
 */
export interface HostGitAppAccess {
  origin: string;
  read: boolean;
  write: boolean;
  error?: string;
}

export interface HostGitState {
  pubkey: string | null;
  access: HostGitAccess;
  /** The App token path, when the repository is on GitHub and was probed. */
  app?: HostGitAppAccess;
  /** The credential helper the host now has configured for github.com. */
  helper?: string;
  identity: "mirrored" | "placeholder" | "kept";
  knownHosts: "pinned" | "laptop" | "none";
  checkedAt: number;
}

/** Which credential a host pushes with, most capable first. */
export type HostAccessPath = "app-token" | "device-key" | "agent-bridge" | "none";

function lastLine(s: string): string | undefined {
  return s.split("\n").map((l) => l.trim()).filter(Boolean).pop();
}

function b64decode(v: unknown): string {
  return typeof v === "string" ? Buffer.from(v, "base64").toString("utf-8") : "";
}

/**
 * The generic trailer git prints under every failed remote (after the line
 * that says why): shown on its own, "and the repository exists." names
 * nothing, and it is the LAST line.
 */
const GIT_GENERIC_STDERR = /^(fatal: Could not read from remote repository\.?|Please make sure you have the correct access rights|and the repository exists\.?|Warning: Permanently added .*)$/i;

/** The line of a failed probe's stderr that says why: the first one outside git's generic trailer, else the last. */
export function probeErrorLine(stderr: string): string | undefined {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => !GIT_GENERIC_STDERR.test(l)) ?? lines.at(-1);
}

/** granted / denied (auth phrase or read-only) / unreachable, from one probe's exit code + stderr. */
export function classifyProbe(rc: number, stderr: string): { ok: boolean; readonly?: boolean; error?: string } {
  if (rc === 0) return { ok: true };
  const s = stderr.toLowerCase();
  const readonly = s.includes("read only") || s.includes("read-only");
  if (readonly) return { ok: false, readonly: true, error: probeErrorLine(stderr) };
  if (isGitAuthError(stderr)) return { ok: false, error: probeErrorLine(stderr) ?? "permission denied" };
  return { ok: false, error: probeErrorLine(stderr) ?? `exit ${rc}` };
}

/**
 * The state the host reported. Takes the LAST JSON line (the script prints
 * nothing else to stdout, but a remote shell banner might); rejects a
 * missing or malformed one naming the host and never echoing the output.
 */
export function parseHostGitOutput(
  out: string,
  hostLabel: string,
  ctx: { origin?: string; appOrigin?: string; knownHosts: HostGitState["knownHosts"] },
): HostGitState {
  const line = out.trim().split("\n").reverse().find((l) => l.trimStart().startsWith("{"));
  if (!line) throw new Error(`host git setup on ${hostLabel} printed no result`);
  let raw: any;
  try { raw = JSON.parse(line); } catch { throw new Error(`host git setup on ${hostLabel} printed an invalid result`); }
  if (!raw || raw.v !== 1) throw new Error(`host git setup on ${hostLabel} printed an unknown result version`);
  const pubkey = b64decode(raw.pubkey).trim() || null;
  const identity: HostGitState["identity"] = raw.identity === "mirrored" || raw.identity === "placeholder" ? raw.identity : "kept";
  const readRc = Number(raw.read_rc), writeRc = Number(raw.write_rc);
  const origin = ctx.origin ?? "";
  let access: HostGitAccess;
  if (!origin) access = { origin, read: false, write: false, error: "no repository origin to probe" };
  else if (!pubkey) access = { origin, read: false, write: false, error: "no device key (ssh-keygen missing on the host)" };
  else if (readRc === -1 || writeRc === -1 || Number.isNaN(readRc) || Number.isNaN(writeRc)) access = { origin, read: false, write: false, error: "probes did not run" };
  else {
    const read = classifyProbe(readRc, b64decode(raw.read_err));
    const write = classifyProbe(writeRc, b64decode(raw.write_err));
    access = {
      origin,
      read: read.ok,
      write: write.ok,
      ...(write.readonly ? { readonly: true } : {}),
      ...(write.error ?? read.error ? { error: write.error ?? read.error } : {}),
    };
  }
  const helper = b64decode(raw.helper).trim() || undefined;
  let app: HostGitAppAccess | undefined;
  if (ctx.appOrigin) {
    const appRc = Number(raw.app_rc);
    const answered = raw.app_cred === 1 || raw.app_cred === "1";
    const probe = answered && appRc !== -1 && !Number.isNaN(appRc) ? classifyProbe(appRc, b64decode(raw.app_err)) : null;
    const ok = !!probe?.ok;
    app = {
      origin: ctx.appOrigin,
      read: ok,
      write: ok,
      ...(ok ? {} : { error: probe?.error || b64decode(raw.app_err) || "the App token path did not answer" }),
    };
  }
  return { pubkey, access, ...(app ? { app } : {}), ...(helper ? { helper } : {}), identity, knownHosts: ctx.knownHosts, checkedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// The laptop entry point
// ---------------------------------------------------------------------------

export interface EnsureHostGitOptions {
  /** The laptop repo being prepared: the origin to probe and the identity profile to mirror. */
  localGitRoot?: string;
  /** The repo's checkout on the host, for the repo-local placeholder unset. */
  repoPath?: string;
  /** Probe this origin instead of the laptop repo's. */
  origin?: string;
  /** `--git-identity "Name <email>"`: overrides what the laptop resolves. */
  gitIdentity?: string;
  /** The registry's last word: IdentitiesOnly=yes while the write probe last passed. */
  identitiesOnly?: boolean;
  /** The comment on a freshly minted key (default: the host's address). */
  keyComment?: string;
  onProgress?: (message: string) => void;
  /** Injection for tests: how the script reaches the host. */
  run?: (host: RemoteHost, script: string) => { status: number | null; stdout: string; stderr: string; error?: Error };
  /** Injection for tests: the laptop known_hosts file `ssh-keygen -F` reads for a non-GitHub origin. */
  laptopKnownHostsFile?: string;
  /** Injection for tests: how long the script waits for the mirror lock (default 60s). */
  lockWaitSeconds?: number;
}

export const HOST_GIT_REMOTE_COMMAND = 'bash -c "$(cat)"';

function runOverSsh(host: RemoteHost, script: string) {
  const r = spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, HOST_GIT_REMOTE_COMMAND], {
    encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], input: script, timeout: 120_000, env: process.env, maxBuffer: 16 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error } : {}) };
}

/** The git root of the current directory, if it is inside a repo. */
export function cwdGitRoot(): string | undefined {
  return gitOut(["rev-parse", "--show-toplevel"]);
}

/** The origin to probe for a laptop repo, if any. */
export function repoOrigin(localGitRoot: string | undefined): string | undefined {
  if (!localGitRoot) return undefined;
  const o = gitOut(["-C", localGitRoot, "remote", "get-url", "origin"]);
  if (!o || o.startsWith("-") || /[\x00-\x1f\x7f]/.test(o)) return undefined;
  return o;
}

/**
 * Make the host's git ready to push: known_hosts, ssh config block, device
 * key, identity, the github.com credential helper, and both access probes.
 * Throws only on transport failure (the host unreachable, the script not
 * delivered); a denied probe is a result, not an error.
 */
export function ensureHostGitReady(host: RemoteHost, opts: EnsureHostGitOptions = {}): HostGitState {
  const requested = opts.origin ?? repoOrigin(opts.localGitRoot);
  // The device key probe always asks for the ssh spelling: the key is an ssh
  // credential, and the App path is probed separately on the https one.
  const probe = hostProbeOrigin(requested);
  const origin = probe.origin;
  const appOrigin = hostAppOrigin(requested);
  const sshHost = originHost(origin ?? requested) ?? "github.com";
  const known = knownHostLinesFor(sshHost, opts.laptopKnownHostsFile);
  const identity = laptopIdentity(opts.localGitRoot, opts.gitIdentity);
  const script = hostGitScript({
    knownHostLines: known.lines,
    sshHost,
    identity: identity.name && identity.email ? identity : undefined,
    keyComment: deviceKeyComment(opts.keyComment ?? `cloud-${host.address}`),
    identitiesOnly: opts.identitiesOnly === true,
    repoPath: opts.repoPath,
    ...(opts.lockWaitSeconds !== undefined ? { lockWaitSeconds: opts.lockWaitSeconds } : {}),
    // A local-path origin (tests, a bare repo on the box) is probed as-is, an
    // ssh one through the device key, a GitHub https one as its ssh form; any
    // other non-ssh origin is not probed (hostProbeOrigin).
    origin,
    ...(appOrigin ? { appOrigin } : {}),
  });
  const label = `${host.user}@${host.address}`;
  const r = (opts.run ?? runOverSsh)(host, script);
  if (r.error) throw new Error(`host git setup on ${label} failed (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})`);
  if (r.status !== 0) {
    const detail = lastLine(r.stderr);
    throw new Error(`host git setup on ${label} failed (exit ${r.status})${detail ? `: ${detail}` : ""}`);
  }
  const state = parseHostGitOutput(r.stdout, label, { origin, ...(appOrigin ? { appOrigin } : {}), knownHosts: known.source });
  if (!origin && requested) state.access = { origin: requested, read: false, write: false, error: probe.reason };
  const log = opts.onProgress;
  if (log) {
    if (state.app?.write) log(`host git: push access to ${state.app.origin} through the codecast GitHub App — no key needed`);
    else if (state.app) log(`host git: the GitHub App token does not cover ${state.app.origin} (${state.app.error ?? "no answer"}); the device key is the path`);
    // A helper git cannot run fails every https operation on the host, so say
    // it here rather than leaving it to the next agent's confusing push error.
    if (!state.helper) log("host git: the github.com credential helper could not be written — the App token path cannot answer on this host");
    else if (!state.helper.startsWith("!/")) log(`host git: cast is not on the host's PATH, so the credential helper is \`${state.helper}\` — git runs it through a shell and will fail if that name does not resolve`);
    if (origin && requested && origin !== requested) log(`host git: probing ${origin} — the ssh form of ${requested}; the host's key works over ssh only`);
    if (!state.pubkey) log("host git: no device key (ssh-keygen missing on the host)");
    else if (!origin) log(`host git: key ready, ${state.identity} identity — ${requested ? probe.reason : "no origin to probe"}`);
    else if (state.access.write) log(`host git: push access to ${origin} (${state.identity} identity)`);
    else if (state.access.read) log(`host git: read-only access to ${origin} — ${state.access.readonly ? "its key is read-only; re-add it with write access" : state.access.error ?? "push refused"}`);
    else log(`host git: no access to ${origin} yet (${state.access.error ?? "key not granted"})`);
  }
  return state;
}

/** The one-line reason a host cannot push, for the `cast hosts key <id>` hint. */
export function noPushReason(access: { read: boolean | null; readonly?: boolean; error?: string }): string {
  if (access.readonly) return "its key is read-only — re-add it with write access";
  if (access.read) return access.error ?? "push refused";
  return access.error ?? "key not granted";
}

/**
 * Which credential a host actually pushes with, in the order they are
 * preferred: an App installation token (nothing for a human to grant and
 * scoped to the repository), then the granted device key, then the laptop's
 * forwarded ssh agent — which only works while a human keeps the bridge up.
 * `none` carries the reason, so every caller says the same sentence.
 */
export function hostAccessPath(
  key: { read: boolean | null; write: boolean | null; readonly?: boolean; error?: string } | undefined,
  app: { write: boolean; error?: string } | undefined,
  bridge = false,
): { path: HostAccessPath; reason?: string } {
  if (app?.write) return { path: "app-token" };
  if (key?.write) return { path: "device-key" };
  if (bridge) return { path: "agent-bridge" };
  if (key && key.write !== null) return { path: "none", reason: noPushReason(key) };
  if (app) return { path: "none", reason: app.error ?? "the GitHub App token path did not answer" };
  return { path: "none", reason: "never probed" };
}
