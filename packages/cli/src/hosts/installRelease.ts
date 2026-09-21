import { execFileSync } from "node:child_process";
import { sshBase, type RemoteHost } from "../remote/session-move.js";

export function hostReleaseScript(platform: "linux" | "darwin", systemLinks = true): string {
  return `set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
curl -fsSL --max-time 60 https://dl.codecast.sh/latest.json -o "$stage/manifest.json"
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
${platform === "linux" && systemLinks ? 'sudo ln -sf "$target" /usr/local/bin/cast\nsudo ln -sf "$target" /usr/local/bin/codecast' : ""}
printf 'CAST-RELEASE=%s\\n' "$expected"`;
}

export function installHostRelease(host: RemoteHost, platform: "linux" | "darwin", log: (message: string) => void): string {
  log("installing the published Codecast release and verifying its checksum…");
  const output = execFileSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, "bash -s"], {
    input: hostReleaseScript(platform), encoding: "utf8", timeout: 300_000, maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const version = output.match(/^CAST-RELEASE=(\d+\.\d+\.\d+)$/m)?.[1];
  if (!version) throw new Error("The remote CLI release did not finish installing");
  return version;
}
