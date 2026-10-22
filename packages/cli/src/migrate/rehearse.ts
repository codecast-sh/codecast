/**
 * A dry run of one session's move to a cloud host, on the machine that holds
 * its files: everything a move would find out the hard way, found while the
 * session still runs here and nothing has been stopped or sent.
 *
 *  - Blockers: the transfer would fail (the host checkout has conflicting or
 *    diverged work, the host has no login or no room).
 *  - Missing: repositories and folders the session works in (footprint.ts)
 *    that the host lacks. A move can bring them (pushSession `bring`).
 *  - Services: launchd jobs from the session's work, which keep running here.
 *  - Tools: commands the session ran that the host lacks, and which of those
 *    the move installs (cloud/hostTools.ts).
 *  - Machine: differences in the machines themselves (OS version).
 *
 * The runner rehearses every row before it stops the session (runner.ts), and
 * the offload review asks for one through the daemon before a person confirms.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "../proc.js";
import type { MoveRehearsal, MoveRehearsalPath } from "@codecast/shared/contracts/moveRehearsal";
import type { CloudHost } from "../browser/cloudHost.js";
import { HOST_TOOLS_PATH } from "../cloud/hostTools.js";
import {
  gitIgnoredPatterns,
  gitRootOf,
  hostFactLine,
  isWorktree,
  parseHostFacts,
  rehearseLanding,
  remoteRepoPath,
  resolveLocalSession,
  ssh,
  type RemoteHost,
} from "../remote/session-move.js";
import { sessionFootprint, type Footprint } from "./footprint.js";
import { hostLoginGap, hostRoom } from "./hosts.js";

/** Bytes of the files a folder transfer carries: everything under `dir` but what git ignores and the folder excludes. */
export function transferBytes(dir: string): number | undefined {
  const inRepo = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf-8" }).stdout?.trim() === "true";
  if (inRepo) {
    const r = spawnSync("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) return undefined;
    let total = 0;
    for (const rel of (r.stdout ?? "").split("\0")) {
      if (!rel) continue;
      try { const st = fs.lstatSync(path.join(dir, rel)); if (st.isFile()) total += st.size; } catch { /* deleted in the tree */ }
    }
    return total;
  }
  const du = spawnSync("du", ["-sk", "-I", "node_modules", "-I", ".git", dir], { encoding: "utf-8", timeout: 30_000 });
  const kb = Number((du.stdout ?? "").split(/\s/)[0]);
  return du.status === 0 && Number.isFinite(kb) ? kb * 1024 : undefined;
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return "size unknown";
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** This machine's OS as one short phrase ("macOS 26.2", "Linux 6.8"). */
function localOs(): string {
  if (process.platform === "darwin") {
    try { return `macOS ${execFileSync("sw_vers", ["-productVersion"], { encoding: "utf-8" }).trim()}`; } catch { return "macOS"; }
  }
  try { return `Linux ${execFileSync("uname", ["-r"], { encoding: "utf-8" }).trim().split("-")[0]}`; } catch { return process.platform; }
}

/** Two OS phrases differ in a way a toolchain notices: another OS, or another major version. */
export function osDiffers(a: string, b: string): boolean {
  const [na, va] = a.split(" "), [nb, vb] = b.split(" ");
  if (na !== nb) return true;
  return !!va && !!vb && va.split(".")[0] !== vb.split(".")[0];
}

/** The shell that reports what the host has of a footprint: its OS, Homebrew access, each path and each tool. */
export function hostProbeScript(paths: string[], tools: string[]): string {
  return [
    HOST_TOOLS_PATH,
    'export PATH="$PATH:/opt/homebrew/bin"',
    hostFactLine("os", `if [ "$(uname -s)" = Darwin ]; then echo "macOS $(sw_vers -productVersion)"; else echo "Linux $(uname -r | cut -d- -f1)"; fi`),
    // Homebrew installs for this login: its own, or through sudo as the login that owns it (provisionMac: ec2-user).
    hostFactLine("brew", `command -v brew >/dev/null && { [ "$(stat -f %Su "$(brew --prefix)" 2>/dev/null)" = "$(id -un)" ] || sudo -n true; } && echo yes`),
    ...paths.map((p, i) => hostFactLine(`path${i}`, `test -e ${shellWord(p)} && echo yes`)),
    ...tools.map((t, i) => hostFactLine(`tool${i}`, `command -v ${shellWord(t)}`)),
  ].join("; ");
}

const shellWord = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export interface RehearseContext {
  host: RemoteHost;
  cloud: CloudHost;
  destinationId: string;
  /** Read the session's footprint (default: from its transcripts). */
  footprint?: (jsonlPath: string, root: string) => Footprint;
  /** Paths the move brings along anyway: not reported missing. */
  bring?: string[];
  now?: () => number;
}

export async function rehearseMove(sessionId: string, ctx: RehearseContext): Promise<MoveRehearsal> {
  const s = resolveLocalSession(sessionId);
  const repo = isWorktree(s.cwd);
  const root = repo ? gitRootOf(s.cwd) : s.cwd;
  const blockers: string[] = [];

  // The session's own checkout: the plan a move makes, stopped before it lands.
  let transfer: MoveRehearsal["transfer"];
  if (repo) {
    const landing = await rehearseLanding(ctx.host, root, remoteRepoPath(ctx.host, root));
    if (landing.error) blockers.push(landing.error);
    transfer = { method: "git", note: landing.hostHas ? "merges into the host checkout" : "clones the repository onto the host" };
  } else {
    const ignored = gitIgnoredPatterns(s.cwd).length;
    transfer = { method: "files", bytes: transferBytes(s.cwd), ...(ignored ? { note: "leaves what git ignores" } : {}) };
  }

  const gap = await hostLoginGap(async () => ctx.host);
  if (gap) blockers.push(`no Claude login on the host (${gap})`);
  const room = await hostRoom(ctx.cloud, root);
  if (room.refuse) blockers.push(`no room on the host (${room.refuse})`);

  const fp = (ctx.footprint ?? sessionFootprint)(s.jsonlPath, root);
  const bring = new Set((ctx.bring ?? []).map((p) => path.resolve(p)));
  const areas = fp.areas.filter((a) => !bring.has(a.path));
  const facts = parseHostFacts(
    ssh(ctx.host, hostProbeScript(areas.map((a) => remoteRepoPath(ctx.host, a.path)), fp.tools.map((t) => t.tool)), 60_000),
    ["os", "brew", ...areas.map((_, i) => `path${i}`), ...fp.tools.map((_, i) => `tool${i}`)],
  );

  const missing: MoveRehearsalPath[] = areas
    .filter((_, i) => !facts[`path${i}`])
    .map((a) => ({ path: a.path, kind: a.kind, bytes: transferBytes(a.path), writes: a.writes, uses: a.uses }));
  const absentTools = fp.tools.filter((_, i) => !facts[`tool${i}`]).map((t) => t.tool);
  const brew = facts.brew === "yes";
  const here = localOs();
  const machine = facts.os && osDiffers(here, facts.os) ? [`${here} here, ${facts.os} on the host`] : [];

  return {
    session_id: sessionId,
    destination_id: ctx.destinationId,
    at: (ctx.now ?? Date.now)(),
    blockers,
    transfer,
    missing,
    services: fp.services.map((sv) => ({ label: sv.label, running: sv.running })),
    // A Mac host installs them through Homebrew when this login can use it (hostTools); a Linux host has no general installer.
    tools: { missing: absentTools, installs: brew && facts.os.startsWith("macOS") ? absentTools : [] },
    machine,
  };
}

/** The rehearsal as lines a moved agent reads in its notice: what it will not find on the host. */
export function rehearsalNotice(r: MoveRehearsal): string[] {
  const out: string[] = [];
  for (const m of r.missing) out.push(`${m.path} (${m.kind === "repo" ? "a repository" : "a folder"} this session ${m.writes ? "wrote to" : "used"}) is not on this host`);
  const running = r.services.filter((sv) => sv.running);
  if (running.length) out.push(`still running on the previous machine: ${running.map((sv) => sv.label).join(", ")}`);
  const absent = r.tools.missing.filter((t) => !r.tools.installs.includes(t));
  if (absent.length) out.push(`commands this session ran that this host lacks: ${absent.join(", ")}`);
  out.push(...r.machine);
  return out;
}
