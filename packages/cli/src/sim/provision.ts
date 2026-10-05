/**
 * Make a cloud Mac able to run iOS simulators: Xcode, an iOS runtime, and axe.
 * Driven from the laptop by `cast hosts setup` when the repo's
 * `.codecast/workspace.toml` (or ~/.codecast/host.toml) declares
 * `[host] simulators = ["iOS"]`.
 *
 * Xcode comes from this laptop, streamed over the host's ssh link
 * (tar | zstd), because Apple serves Xcode only behind an Apple ID sign-in and
 * a laptop that builds the app already has the right one. The iOS runtime is
 * then fetched on the host by `xcodebuild -downloadPlatform iOS`, which needs
 * no sign-in and runs on the host's own bandwidth. axe comes from its Homebrew
 * tap, run as whichever account owns the host's Homebrew.
 *
 * Every step checks first, so a host in step costs one ssh round trip.
 */

import * as fs from "node:fs";
import { spawnSync } from "../proc.js";
import { sshBase, type RemoteHost } from "../remote/session-move.js";

export const HOST_XCODE = "/Applications/Xcode.app";
const PATH_LINE = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"';

export interface SimHostState {
  macos: string;
  xcode?: string;
  selected?: string;
  license: boolean;
  runtimes: string[];
  axe?: string;
  zstd: boolean;
}

export function probeScript(): string {
  return `${PATH_LINE}
x=""; [ -d ${HOST_XCODE} ] && x=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" ${HOST_XCODE}/Contents/Info.plist 2>/dev/null)
sel=$(xcode-select -p 2>/dev/null)
lic=0; case "$sel" in ${HOST_XCODE}/*) xcodebuild -license check >/dev/null 2>&1 && xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1 && lic=1;; esac
rts=""; [ "$lic" = 1 ] && rts=$(xcrun simctl list runtimes 2>/dev/null | awk '/^iOS / && !/unavailable/ {print $2}' | paste -sd, -)
ax=$(command -v axe || true); axv=""; [ -n "$ax" ] && axv=$(axe --version 2>/dev/null | tail -1)
zs=0; command -v zstd >/dev/null && zs=1
q() { [ -n "$1" ] && printf '"%s"' "$1" || printf null; }
# Plain printf, not python3: until the license is accepted, /usr/bin/python3 is an Xcode shim that refuses to run.
printf '{"macos":"%s","xcode":%s,"selected":%s,"license":%s,"runtimes":[%s],"axe":%s,"zstd":%s}\n' "$(sw_vers -productVersion)" "$(q "$x")" "$(q "$sel")" "$([ "$lic" = 1 ] && echo true || echo false)" "$(printf '%s' "$rts" | sed 's/[^,][^,]*/"&"/g')" "$(q "$axv")" "$([ "$zs" = 1 ] && echo true || echo false)"`;
}

function ssh(host: RemoteHost, script: string, timeoutMs: number, input?: string): { ok: boolean; out: string } {
  const r = spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, input === undefined ? "bash -s" : script], {
    encoding: "utf-8", input: input === undefined ? script : input, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export function probeSimHost(host: RemoteHost): SimHostState {
  const r = ssh(host, probeScript(), 60_000);
  const line = r.out.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) throw new Error(`the host did not answer the simulator probe: ${r.out.slice(-300)}`);
  const s = JSON.parse(line);
  return { ...s, xcode: s.xcode ?? undefined, selected: s.selected ?? undefined, axe: s.axe ?? undefined };
}

/** The laptop Xcode to send: the selected developer dir's app bundle. */
export function laptopXcode(): { app: string; version: string; minMacos?: string } | undefined {
  const dev = spawnSync("xcode-select", ["-p"], { encoding: "utf-8" }).stdout?.trim() ?? "";
  const app = dev.replace(/\/Contents\/Developer\/?$/, "");
  if (!app.endsWith(".app") || !fs.existsSync(app)) return undefined;
  const plist = (key: string) => spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, `${app}/Contents/Info.plist`], { encoding: "utf-8" }).stdout?.trim() || undefined;
  const version = plist("CFBundleShortVersionString");
  return version ? { app, version, minMacos: plist("LSMinimumSystemVersion") } : undefined;
}

const versionAtLeast = (have: string, want: string) => {
  const a = have.split(".").map(Number), b = want.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

export function streamXcode(host: RemoteHost, app: string, log: (m: string) => void, dest = HOST_XCODE): void {
  const zstd = ["/opt/homebrew/bin/zstd", "/usr/local/bin/zstd"].find((p) => fs.existsSync(p));
  const [pack, unpack] = zstd ? [`${zstd} -1 -T0`, "zstd -d"] : ["gzip -1", "gzip -d"];
  const dir = app.slice(0, app.lastIndexOf("/"));
  const name = app.slice(app.lastIndexOf("/") + 1);
  const remote = `${PATH_LINE}; set -e; rm -rf /tmp/cast-xcode; mkdir -p /tmp/cast-xcode; cd /tmp/cast-xcode; ${unpack} | tar -xf -; sudo -n rm -rf '${dest}'; sudo -n mv '${name}' '${dest}'; rm -rf /tmp/cast-xcode; ${dest === HOST_XCODE ? `${activateLines()}; ` : ""}echo XCODE-IN-PLACE`;
  log(`streaming ${app} to the host (several GB; this takes a while)…`);
  const sshCmd = ["ssh", ...sshBase(host), `${host.user}@${host.address}`, remote].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const r = spawnSync("bash", ["-c", `set -o pipefail; tar -C '${dir}' -cf - '${name}' | ${pack} | ${sshCmd}`], { encoding: "utf-8", timeout: 4 * 3600_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0 || !(r.stdout ?? "").includes("XCODE-IN-PLACE")) throw new Error(`Xcode copy failed: ${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(-400)}`);
}

/**
 * Select Xcode and accept its license in one step. Until the license is
 * accepted, every /usr/bin developer shim (python3, git, make) refuses to run
 * once Xcode is the selected developer dir, which breaks the host's other
 * scripts; so the copy runs this right after the move, never later.
 */
function activateLines(): string {
  const xcodebuild = `${HOST_XCODE}/Contents/Developer/usr/bin/xcodebuild`;
  return `sudo -n xcode-select -s ${HOST_XCODE}/Contents/Developer && sudo -n ${xcodebuild} -license accept && sudo -n ${xcodebuild} -runFirstLaunch`;
}

export function activateScript(): string {
  return `${PATH_LINE}; set -e
${activateLines()}
echo XCODE-ACTIVE`;
}

export function axeInstallScript(): string {
  return `${PATH_LINE}; set -e
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
brew=$(command -v brew)
owner=$(stat -f %Su "$brew")
if [ "$owner" = "$USER" ]; then "$brew" install cameroncooke/axe/axe; else sudo -n -u "$owner" -H "$brew" install cameroncooke/axe/axe; fi
command -v zstd >/dev/null || { if [ "$owner" = "$USER" ]; then "$brew" install zstd; else sudo -n -u "$owner" -H "$brew" install zstd; fi; }
axe --version | tail -1`;
}

export interface SimProvisionReport {
  before: SimHostState;
  after: SimHostState;
  steps: string[];
}

export function provisionSimHost(host: RemoteHost, platforms: string[], log: (m: string) => void): SimProvisionReport {
  const before = probeSimHost(host);
  const steps: string[] = [];
  if (!before.xcode) {
    const local = laptopXcode();
    if (!local) throw new Error("the host has no Xcode and this laptop has none to send: install Xcode here first");
    if (local.minMacos && !versionAtLeast(before.macos, local.minMacos)) {
      throw new Error(`this laptop's Xcode ${local.version} needs macOS ${local.minMacos}; the host runs ${before.macos}`);
    }
    streamXcode(host, local.app, log);
    steps.push(`copied Xcode ${local.version}`);
  }
  let state = before.xcode ? before : probeSimHost(host);
  if (!state.license || !state.selected?.startsWith(HOST_XCODE)) {
    log("selecting Xcode, accepting its license, installing its components…");
    const r = ssh(host, activateScript(), 30 * 60_000);
    if (!r.out.includes("XCODE-ACTIVE")) throw new Error(`Xcode activation failed: ${r.out.trim().slice(-400)}`);
    steps.push("activated Xcode");
  }
  for (const platform of platforms) {
    if (platform !== "iOS") { log(`simulators for ${platform} are not provisioned yet; skipping`); continue; }
    state = probeSimHost(host);
    if (state.runtimes.length) continue;
    log(`downloading the ${platform} simulator runtime on the host (several GB)…`);
    const r = ssh(host, `${PATH_LINE}; xcodebuild -downloadPlatform ${platform} 2>&1 | tail -5`, 3 * 3600_000);
    steps.push(`downloaded the ${platform} runtime`);
    if (!r.ok) throw new Error(`${platform} runtime download failed: ${r.out.trim().slice(-400)}`);
  }
  if (!state.axe) {
    log("installing axe…");
    const r = ssh(host, axeInstallScript(), 20 * 60_000);
    if (!r.ok) throw new Error(`axe install failed: ${r.out.trim().slice(-400)}`);
    steps.push("installed axe");
  }
  const after = probeSimHost(host);
  return { before, after, steps };
}

export function describeSimHost(s: SimHostState): string {
  return [
    s.xcode ? `Xcode ${s.xcode}` : "no Xcode",
    s.runtimes.length ? `iOS ${s.runtimes.join(", ")}` : "no iOS runtime",
    s.axe ? `axe ${s.axe}` : "no axe",
  ].join(", ");
}
