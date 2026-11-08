import { execFileSync } from "../proc.js";
import { SHARED_HOST_MARKER } from "../remote/sharedHostGuard.js";
import { sshBase, type RemoteHost } from "../remote/session-move.js";

/**
 * What a host runs: the published release (the default), which updates itself
 * like every other client, or a build of this checkout for trying a fix that
 * is not released yet. A checkout build is a dev build to the updater, so it
 * stands down for every update, forced ones included, until the host is put
 * back on a release.
 */
export type HostCastSource = "release" | "checkout";

const RELEASES = "https://dl.codecast.sh";

/** A host that cannot be brought to this laptop's cast. Whatever was about to
 *  start there (a placement, a moved session) stops on it. */
export class HostCastBehind extends Error {
  override name = "HostCastBehind";
}
const VERSION = /^\d+\.\d+\.\d+$/;

/** One published release, in latest.json's shape: its version and, per
 *  `<system>-<arch>`, where its binary is and the binary's sha256. */
export type CastRelease = { version: string; binaries: Record<string, { url: string; sha256: string }> };

function fetchJson(url: string): any {
  const out = execFileSync("curl", ["-fsSL", "--max-time", "30", url], { encoding: "utf8", timeout: 40_000, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(String(out));
}

/** The release dl.codecast.sh publishes as latest, or null when it cannot be read. */
export function latestRelease(fetch: (url: string) => any = fetchJson): CastRelease | null {
  try {
    const manifest = fetch(`${RELEASES}/latest.json`);
    return typeof manifest?.version === "string" && VERSION.test(manifest.version) && manifest.binaries ? manifest : null;
  } catch {
    return null;
  }
}

/** The version dl.codecast.sh publishes as latest, or null when it cannot be read. */
export function latestReleaseVersion(): string | null {
  return latestRelease()?.version ?? null;
}

/** Commits the release commit can be among: the tag's own history, newest
 *  first. Finalize commits the version bump on top of whatever main's tip is
 *  then, so the commit the release was cut from is usually the tag's parent
 *  and sometimes a few further down. */
const RELEASE_COMMIT_SEARCH = 10;

function githubJson(url: string): any {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const out = execFileSync("curl", ["-fsSL", "--max-time", "30", "-H", "Accept: application/vnd.github+json", ...(token ? ["-H", `Authorization: Bearer ${token}`] : []), url], { encoding: "utf8", timeout: 40_000, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(String(out));
}

/**
 * The published release of exactly `version`. Latest when it is that one;
 * otherwise its immutable objects on R2, which live under the commit the
 * release was cut from (cli/releases/v<version>/<commit>/): the newest commit
 * at or below the tag that has a release.json there. Throws, naming what
 * could not be read.
 */
export function releaseFor(version: string, fetch: (url: string) => any = fetchJson, github: (url: string) => any = githubJson): CastRelease {
  if (!VERSION.test(version)) throw new Error(`cast ${version} is not a published release version`);
  const latest = latestRelease(fetch);
  if (latest?.version === version) return latest;
  let commits: string[] = [];
  try {
    const listed = github(`https://api.github.com/repos/codecast-sh/codecast/commits?sha=v${version}&per_page=${RELEASE_COMMIT_SEARCH}`);
    commits = Array.isArray(listed) ? listed.map((c: any) => c?.sha).filter((sha: unknown): sha is string => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)) : [];
  } catch { /* named below */ }
  if (!commits.length) throw new Error(`could not read the history of GitHub tag v${version}, which locates cast ${version}'s release objects`);
  for (const commit of commits) {
    const prefix = `${RELEASES}/cli/releases/v${version}/${commit}`;
    let artifacts: Record<string, { sha256?: string }> | undefined;
    try {
      artifacts = fetch(`${prefix}/release.json`)?.artifacts;
    } catch {
      continue;
    }
    if (!artifacts) continue;
    const binaries: CastRelease["binaries"] = {};
    for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
      const sha256 = artifacts[`codecast-${target}`]?.sha256;
      if (sha256) binaries[target] = { url: `${prefix}/codecast-${target}`, sha256 };
    }
    return { version, binaries };
  }
  throw new Error(`cast ${version} has no published release objects under the last ${commits.length} commits of tag v${version}`);
}

/**
 * The install script a host runs. With `release` it installs exactly that
 * release; without, whatever latest.json names when the script runs.
 */
export function hostReleaseScript(platform: "linux" | "darwin", systemLinks = true, release?: CastRelease): string {
  const manifest = release
    ? `cat > "$stage/manifest.json" <<'MANIFEST'\n${JSON.stringify(release)}\nMANIFEST`
    : `curl -fsSL --max-time 60 https://dl.codecast.sh/latest.json -o "$stage/manifest.json"`;
  return `set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
${manifest}
python3 - "$stage" '${platform}' <<'PY'
import hashlib, json, os, platform, re, subprocess, sys
stage, system = sys.argv[1:]
arch = {"x86_64": "x64", "amd64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine())
if not arch:
    raise SystemExit("Unsupported host architecture")
with open(os.path.join(stage, "manifest.json")) as source:
    manifest = json.load(source)
version = manifest["version"]
if not re.fullmatch(r"[0-9]+\\.[0-9]+\\.[0-9]+", version):
    raise SystemExit("Invalid release version")
binary = manifest["binaries"][system + "-" + arch]
url, expected = binary["url"], binary["sha256"]
if not url.startswith("https://dl.codecast.sh/cli/releases/") or not re.fullmatch(r"[a-f0-9]{64}", expected):
    raise SystemExit("Invalid release artifact")
digest = hashlib.sha256()
binary_path = os.path.join(stage, "cast")
subprocess.run(["curl", "-fsSL", "--max-time", "180", url, "-o", binary_path], check=True)
with open(binary_path, "rb") as source:
    while chunk := source.read(1024 * 1024):
        digest.update(chunk)
if digest.hexdigest() != expected:
    raise SystemExit("Release checksum mismatch; installed CLI unchanged")
with open(os.path.join(stage, "version"), "w") as target:
    target.write(version)
PY
chmod 755 "$stage/cast"
expected=$(cat "$stage/version")
actual=$("$stage/cast" --version)
[ "$actual" = "$expected" ] || { echo 'Release version check failed; installed CLI unchanged' >&2; exit 1; }
mkdir -p "$HOME/.local/bin"
target="$HOME/.local/bin/cast"
if [ -e "$target" ] && [ ! -e "$target.before-remote-release" ]; then cp -p "$target" "$target.before-remote-release"; fi
cp "$stage/cast" "$target.next"
chmod 755 "$target.next"
mv -f "$target.next" "$target"
ln -sf cast "$HOME/.local/bin/codecast"
${platform === "linux" && systemLinks ? `# A shared host keeps /usr/local/bin free of links into homes (docs/architecture/shared-hosts.md).
if [ ! -e ${SHARED_HOST_MARKER} ]; then sudo ln -sf "$target" /usr/local/bin/cast; sudo ln -sf "$target" /usr/local/bin/codecast; fi` : ""}
printf 'CAST-RELEASE=%s\\n' "$expected"`;
}

export function installHostRelease(host: RemoteHost, platform: "linux" | "darwin", log: (message: string) => void, release?: CastRelease): string {
  log(`installing ${release ? `Codecast ${release.version}` : "the published Codecast release"} and verifying its checksum…`);
  const output = execFileSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, "bash -s"], {
    input: hostReleaseScript(platform, true, release), encoding: "utf8", timeout: 300_000, maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const version = output.match(/^CAST-RELEASE=(\d+\.\d+\.\d+)$/m)?.[1];
  if (!version) throw new Error("The remote CLI release did not finish installing");
  return version;
}
