/**
 * `cast hosts` — the remote machines codecast can run on.
 *
 * The group started life under `cast browser` because a remote Chrome was the
 * first thing anyone put on a cloud box. It is no longer only that: the same
 * instance runs a codecast daemon, holds git worktrees and hosts sessions
 * moved there from a laptop. So the builder lives here and is mounted twice —
 * at the top level as `cast hosts`, and under `cast browser hosts`, which
 * keeps every documented command working. One implementation, two names.
 *
 * `ls` answers the question a person actually has when they think about these
 * machines: what is running on it, and what is it costing me. That means one
 * block per host with its state, its codecast device, its live sessions, its
 * worktrees and a price estimate. Each of those comes from a different system
 * (AWS, Convex, SSH), so every one of them is fetched behind its own guard:
 * a field that cannot be read prints "unknown (reason)" and the rest of the
 * block still prints. A sleeping host, a missing aws CLI and an expired token
 * are all ordinary states here, not failures.
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { Command } from "commander";
import { fmt, icons } from "../colors.js";
import { formatAgeShort } from "../publishCommand.js";
import {
  describeHostHardware, ensureUp, hostState, readHosts, stopHost, toRemoteHost, upsertHost, writeHosts,
  type CloudHost, type HostState,
} from "../browser/cloudHost.js";
import { ssh } from "../remote/session-move.js";

const OK = fmt.success(icons.check);

function die(msg: string, hint?: string): never {
  console.error(`${fmt.error(icons.cross)} ${msg}`);
  if (hint) console.error(`  ${fmt.muted(hint)}`);
  process.exit(1);
}

// --------------------------------------------------------------------------
// Cost
// --------------------------------------------------------------------------

/**
 * On-demand USD per hour, us-west-2, Linux. A short table on purpose: these
 * are the types we actually launch, and a wrong price is worse than an
 * admitted unknown, so an unlisted type prints "rate unknown" rather than
 * being guessed from its family.
 */
export const EC2_HOURLY_USD: Record<string, number> = {
  "t3.micro": 0.0104,
  "t3.small": 0.0208,
  "t3.medium": 0.0416,
  "t3.large": 0.0832,
  "t3.xlarge": 0.1664,
  "m5.large": 0.096,
  "m5.xlarge": 0.192,
  "c5.large": 0.085,
  "c5.xlarge": 0.17,
};

/** gp3 storage, USD per GiB-month. This is the whole bill of a sleeping host. */
export const GP3_USD_PER_GIB_MONTH = 0.08;

export interface HostCost {
  hourlyUsd: number | null;
  diskMonthlyUsd: number | null;
  line: string;
}

/** Money, to the cent. */
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** An hourly rate, which is cents-per-hour small: four places, no padding. */
function usdRate(n: number): string {
  return `$${n.toFixed(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}

/**
 * What this machine costs, in the one sentence a person needs.
 *
 * A stopped instance bills only its disk, which is the entire argument for
 * Linux over a Mac, so the asleep line names that explicitly. A running one
 * shows both halves: the hourly rate it is burning now, and the disk it will
 * keep costing after it sleeps.
 */
export function estimateHostCost(input: {
  instanceType?: string;
  volumeGiB?: number;
  state: HostState | string;
}): HostCost {
  const hourlyUsd = input.instanceType ? EC2_HOURLY_USD[input.instanceType] ?? null : null;
  const diskMonthlyUsd = typeof input.volumeGiB === "number" ? input.volumeGiB * GP3_USD_PER_GIB_MONTH : null;
  const disk = diskMonthlyUsd === null ? "disk size unknown" : `about ${usd(diskMonthlyUsd)}/month disk`;

  if (input.state === "missing") return { hourlyUsd, diskMonthlyUsd, line: "gone: nothing left to bill" };

  if (input.state !== "running") {
    const line =
      diskMonthlyUsd === null
        ? "asleep: disk size unknown"
        : `asleep: about ${usd(diskMonthlyUsd)}/month (disk only)`;
    return { hourlyUsd, diskMonthlyUsd, line };
  }

  const rate =
    hourlyUsd === null
      ? `rate unknown for ${input.instanceType ?? "an unknown instance type"}`
      : `about ${usdRate(hourlyUsd)}/hour running`;
  return { hourlyUsd, diskMonthlyUsd, line: `awake: ${rate}, ${disk}` };
}

// --------------------------------------------------------------------------
// Worktrees, read from the host itself
// --------------------------------------------------------------------------

export interface RemoteWorktree {
  /** The checkout the worktree belongs to, e.g. "codecast". */
  repo: string;
  name: string;
  state: string;
  branch: string;
  path: string;
}

/**
 * Every repo checkout on the box that codecast manages worktrees for, asked
 * for its own `cast ws ls`. The host is the authority here: it allocated the
 * worktrees and their ports, so reading its answer beats inferring one from
 * session rows, which only know about worktrees that still have a session.
 */
export const REMOTE_WORKSPACE_LIST_SCRIPT =
  'for d in ~/work/*/; do [ -f "$d/.codecast/workspace.toml" ] && (cd "$d" && echo "## $d" && cast ws ls); done';

/**
 * Parse the concatenated `cast ws ls` output. Each checkout is announced by a
 * `## <path>` line; then a NAME/STATE/BRANCH/PATH table, or "(no workspaces)".
 * Anything that is not four columns is dropped, which is how a shell warning
 * or a stray error line on stderr fails to become a phantom worktree.
 */
export function parseRemoteWorkspaceList(out: string): RemoteWorktree[] {
  const rows: RemoteWorktree[] = [];
  let repo = "";
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    const header = /^##\s+(.*)$/.exec(line);
    if (header) {
      repo = path.posix.basename(header[1].trim().replace(/\/+$/, ""));
      continue;
    }
    const t = line.trim();
    if (!t || t === "(no workspaces)" || t.startsWith("NAME ")) continue;
    const cells = t.split(/\s{2,}/);
    if (cells.length < 4) continue;
    const [name, state, branch, ...rest] = cells;
    rows.push({ repo, name, state, branch, path: rest.join("  ") });
  }
  return rows;
}

// --------------------------------------------------------------------------
// The report behind `ls`
// --------------------------------------------------------------------------

export interface HostSession {
  short_id: string;
  title: string | null;
  status: string | null;
  work_state: string | null;
  worktree_name: string | null;
  worktree_branch: string | null;
  project_path: string | null;
  updated_at: number | null;
}

export interface HostReport {
  id: string;
  provider: string;
  region: string;
  state: HostState | "unknown";
  address: string | null;
  stateError?: string;
  device: {
    id: string | null;
    label: string | null;
    online: boolean | null;
    lastSeen: number | null;
    note?: string;
  };
  sessions: HostSession[];
  sessionsError?: string;
  worktrees: Array<RemoteWorktree & { hasSession: boolean }>;
  worktreesNote?: string;
  cost: HostCost & { instanceType: string | null; volumeGiB: number | null; error?: string };
}

/** Run something that talks to another system; hand back its failure as text. */
async function guard<T>(fn: () => Promise<T> | T): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (err) {
    return { error: (err as Error).message.split("\n")[0] || "failed" };
  }
}

type Convex = { client: any; token: string; api: any } | null;

/** One Convex client for the whole listing, or null when we cannot get one. */
async function openConvex(): Promise<{ convex: Convex; error?: string }> {
  const { value, error } = await guard(async () => (await import("../remote/cli.js")).convexClient());
  return { convex: value ?? null, error };
}

async function collectHostReport(host: CloudHost, convex: Convex, convexError?: string): Promise<HostReport> {
  const state = await guard(() => hostState(host));
  const live = state.value?.state === "running";
  const address = state.value?.address ?? (live ? host.address ?? null : null);
  // The host with its address as of RIGHT NOW: a booted instance gets a new
  // one, and the registry's copy is only trustworthy until it next sleeps.
  const current: CloudHost = { ...host, address: address ?? undefined };

  // The device id: from the registry when we already know it, else learned
  // over SSH — which only works while the box is up.
  let deviceId = host.deviceId ?? null;
  let deviceNote: string | undefined;
  if (!deviceId) {
    if (!live) deviceNote = "device id unknown until it wakes";
    else {
      const learned = await guard(async () => {
        const { learnHostDeviceId } = await import("../cloud/prepare.js");
        return learnHostDeviceId(current, toRemoteHost(current));
      });
      deviceId = learned.value ?? null;
      if (!deviceId) deviceNote = learned.error ? `unknown (${learned.error})` : "no codecast daemon answered";
    }
  }

  let deviceLabel: string | null = null;
  let deviceOnline: boolean | null = null;
  let deviceLastSeen: number | null = null;
  if (deviceId && convex) {
    const devices = await guard(() =>
      convex.client.query(convex.api.devices.listDevices, { api_token: convex.token }),
    );
    if (devices.error) deviceNote = `unknown (${devices.error})`;
    const row = (devices.value ?? []).find((d: any) => d.device_id === deviceId);
    if (row) {
      deviceLabel = row.label ?? null;
      deviceOnline = !!row.online;
      deviceLastSeen = row.last_seen ?? null;
    } else if (!devices.error) deviceNote = "not in this account's device list";
  } else if (deviceId && !convex) {
    deviceNote = `unknown (${convexError ?? "no convex client"})`;
  }

  let sessions: HostSession[] = [];
  let sessionsError: string | undefined;
  if (deviceId && convex) {
    const rows = await guard(() =>
      convex.client.query(convex.api.cloud.hostSessions, { api_token: convex.token, device_id: deviceId }),
    );
    sessions = (rows.value ?? []) as HostSession[];
    sessionsError = rows.error;
  } else if (deviceId && !convex) {
    sessionsError = convexError ?? "no convex client";
  }

  const sessionWorktrees = new Set(sessions.map((s) => s.worktree_name).filter(Boolean) as string[]);

  let worktrees: Array<RemoteWorktree & { hasSession: boolean }> = [];
  let worktreesNote: string | undefined;
  if (live && address) {
    const listed = await guard(() =>
      parseRemoteWorkspaceList(ssh(toRemoteHost(current), REMOTE_WORKSPACE_LIST_SCRIPT, 60_000)),
    );
    if (listed.error) worktreesNote = `unknown (${listed.error})`;
    worktrees = (listed.value ?? []).map((w) => ({ ...w, hasSession: sessionWorktrees.has(w.name) }));
  } else {
    worktreesNote = "host is asleep — these are the ones its sessions name";
    worktrees = [...sessionWorktrees].map((name) => ({
      repo: "", name, state: "", branch: "", path: "", hasSession: true,
    }));
  }

  const hardware = await guard(() => describeHostHardware(host));
  const cost = estimateHostCost({
    instanceType: hardware.value?.instanceType,
    volumeGiB: hardware.value?.volumeGiB,
    state: state.value?.state ?? "unknown",
  });

  return {
    id: host.id,
    provider: host.provider,
    region: host.region,
    state: state.value?.state ?? "unknown",
    address,
    ...(state.error ? { stateError: state.error } : {}),
    device: { id: deviceId, label: deviceLabel, online: deviceOnline, lastSeen: deviceLastSeen, ...(deviceNote ? { note: deviceNote } : {}) },
    sessions,
    ...(sessionsError ? { sessionsError } : {}),
    worktrees,
    ...(worktreesNote ? { worktreesNote } : {}),
    cost: {
      ...cost,
      instanceType: hardware.value?.instanceType ?? null,
      volumeGiB: hardware.value?.volumeGiB ?? null,
      ...(hardware.error ? { error: hardware.error } : {}),
    },
  };
}

function sessionLine(s: HostSession): string {
  const where = s.worktree_name ?? (s.project_path ? path.basename(s.project_path) : "");
  const title = (s.title ?? "").trim() || (s.project_path ? path.basename(s.project_path) : "(untitled)");
  const work = s.work_state ?? s.status ?? "";
  return `${fmt.id(s.short_id.padEnd(8))} ${fmt.muted(where.padEnd(16))} ${title.slice(0, 44).padEnd(44)} ${fmt.muted(work)}`;
}

function printHostReport(r: HostReport): void {
  const mark =
    r.state === "running" ? fmt.success("awake")
    : r.state === "stopped" ? fmt.muted("asleep")
    : r.state === "unknown" ? fmt.warning(`unknown (${r.stateError ?? "no answer"})`)
    : fmt.warning(r.state);
  console.log(`${fmt.highlight(r.id)}  ${fmt.muted(`${r.provider} · ${r.region}`)}`);
  console.log(`  state      ${mark}${r.address ? `  ${r.address}` : ""}`);

  const dev = r.device;
  const devText = dev.id
    ? `${dev.label ?? "(unlabelled)"} ${dev.online === null ? fmt.muted("(daemon state unknown)") : dev.online ? fmt.success("online") : fmt.muted(`offline, last seen ${dev.lastSeen ? formatAgeShort(Date.now() - dev.lastSeen) + " ago" : "never"}`)}  ${fmt.muted(dev.id)}`
    : fmt.muted(dev.note ?? "unknown");
  console.log(`  device     ${devText}${dev.id && dev.note ? `  ${fmt.muted(dev.note)}` : ""}`);

  if (r.sessionsError) console.log(`  sessions   ${fmt.muted(`unknown (${r.sessionsError})`)}`);
  else if (!r.sessions.length) console.log(`  sessions   ${fmt.muted("none")}`);
  else {
    console.log(`  sessions   ${r.sessions.length}`);
    for (const s of r.sessions) console.log(`    ${sessionLine(s)}`);
  }

  console.log(`  worktrees  ${r.worktreesNote ? fmt.muted(r.worktreesNote) : r.worktrees.length ? "" : fmt.muted("none")}`);
  for (const w of r.worktrees) {
    const orphan = w.hasSession ? "" : fmt.warning("  no session (orphan)");
    const cols = [w.repo, w.name, w.state, w.branch].filter(Boolean);
    console.log(`    ${cols.join("  ")}${orphan}`);
  }

  console.log(`  cost       ${r.cost.line}${r.cost.error ? fmt.muted(`  (hardware unknown: ${r.cost.error})`) : ""}`);
}

// --------------------------------------------------------------------------
// The command group
// --------------------------------------------------------------------------

/** The registered host an id names, or the default Linux one. */
function pick(id: string | undefined, what: string): CloudHost {
  const rows = readHosts();
  const h = id ? rows.find((r) => r.id === id) : rows.find((r) => r.provider === "aws");
  if (!h) die(id ? `no host ${id}` : what, "`cast hosts add <instance-id> --key <pem>` first");
  return h;
}

/**
 * Attach the whole group to a parent command. `cast hosts` and
 * `cast browser hosts` both call this, so neither can drift from the other.
 */
export function buildHostsCommand(parent: Command): Command {
  const hosts = parent.command("hosts").description("Remote machines: what runs on them, and what they cost");

  hosts
    .command("ls", { isDefault: true })
    .description("List remote hosts: state, device, sessions, worktrees and cost")
    .option("--json", "Machine-readable report")
    .action(async (o: { json?: boolean }) => {
      const rows = readHosts();
      if (!rows.length) {
        if (o.json) console.log("[]");
        else console.log(fmt.muted("no remote hosts registered — `cast hosts add --help`"));
        return;
      }
      const { convex, error } = await openConvex();
      const reports: HostReport[] = [];
      for (const h of rows) reports.push(await collectHostReport(h, convex, error));
      if (o.json) {
        console.log(JSON.stringify(reports, null, 2));
        return;
      }
      for (const r of reports) {
        printHostReport(r);
        console.log("");
      }
      console.log(
        fmt.muted(
          "  A Linux host sleeps when idle and then costs only its disk, about a dollar a month.\n" +
            "  An Apple silicon Mac cannot sleep — Apple's licence sets a 24-hour minimum lease, so it\n" +
            "  bills continuously (~EUR75/month) until deleted. Use one only for work that needs macOS.",
        ),
      );
    });

  hosts
    .command("add <instanceId>")
    .description("Register an existing EC2 instance as a host")
    .requiredOption("--key <path>", "SSH private key for it")
    .option("--region <name>", "AWS region", "us-west-2")
    .option("--user <name>", "SSH user for the image", "ubuntu")
    .action((instanceId: string, o: { key: string; region: string; user: string }) => {
      const host: CloudHost = {
        id: instanceId, provider: "aws", region: o.region, user: o.user,
        keyPath: path.resolve(o.key),
      };
      const s = hostState(host);
      if (s.state === "missing") die(`${instanceId} was not found in ${o.region}`);
      upsertHost({ ...host, address: s.address });
      console.log(`${OK} registered ${instanceId} (${s.state})`);
    });

  hosts
    .command("provision [id]")
    .description("Set up a Linux host as a full remote service: display, live stream, idle auto-stop, codecast daemon")
    .option("--idle <minutes>", "Auto-stop after this many idle minutes (0 disables)", "20")
    .option("--no-daemon", "Skip the codecast daemon (browser + stream only; sessions cannot move there)")
    .action(async (id: string | undefined, o: { idle: string; daemon: boolean }) => {
      const h = pick(id, "no linux host registered");
      const idle = parseInt(o.idle, 10);
      const { provisionLinuxHost } = await import("../browser/provisionLinux.js");
      console.log(`provisioning ${h.id} (${h.region})…`);
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      try {
        const report = await provisionLinuxHost(toRemoteHost(up), { idleStopMinutes: idle, skipDaemon: !o.daemon }, (m) =>
          console.log(fmt.muted(`  ${m}`)),
        );
        upsertHost({ ...up, idleStopMinutes: idle });
        console.log(`${OK} ${h.id} is a full remote service`);
        console.log(`  chrome:   ${report.chrome.trim()}`);
        console.log(`  cast:     ${report.cast.trim()}`);
        console.log(`  claude:   ${report.claude.trim()}`);
        console.log(`  services: ${report.services.trim()}`);
        console.log(`  daemon:   ${report.device.trim()}`);
        console.log(fmt.muted(`  idle auto-stop: ${idle ? `${idle}m` : "disabled"} — it powers itself off and costs only its disk`));
        console.log(fmt.muted(`  watch it: cast hosts view`));
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("wake [id]")
    .description("Start a sleeping host and wait until it accepts connections")
    .action(async (id: string | undefined) => {
      const h = pick(id, "no linux host registered");
      try {
        const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
        console.log(`${OK} ${up.id} is awake at ${fmt.highlight(up.address ?? "(no address)")}`);
        const { learnHostDeviceId } = await import("../cloud/prepare.js");
        const deviceId = await learnHostDeviceId(up, toRemoteHost(up));
        console.log(
          deviceId
            ? `  device: ${fmt.muted(deviceId)}`
            : fmt.muted("  no codecast daemon answered — `cast hosts provision` if sessions should run there"),
        );
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("view [id]")
    .description("Live view of the host's screen — VLC (RTSP) or any browser (HLS), over an SSH tunnel")
    .option("--vlc", "Open it in VLC")
    .action(async (id: string | undefined, o: { vlc?: boolean }) => {
      const h = pick(id, "no linux host registered");
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      const { ensureViewTunnel } = await import("../browser/liveView.js");
      try {
        const v = await ensureViewTunnel(toRemoteHost(up));
        console.log(`${OK} live view is up${v.tunnelPid ? ` (tunnel pid ${v.tunnelPid})` : " (reusing the existing tunnel)"}`);
        console.log(`  VLC:     ${fmt.highlight(v.rtsp)}`);
        console.log(`  browser: ${fmt.highlight(v.hls)}`);
        console.log(fmt.muted("  the stream only encodes while someone is watching; closing the player stops it"));
        if (o.vlc) {
          try {
            execFileSync("open", ["-a", "VLC", v.rtsp], { stdio: "ignore", timeout: 10_000 });
            console.log(`${OK} opened in VLC`);
          } catch {
            console.log(fmt.warning("  VLC is not installed — `brew install --cask vlc`, or open the browser URL"));
          }
        }
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("vnc [id]")
    .description("Interactive view of the host's whole screen (noVNC in your browser) — for anything outside the agent's tab")
    .option("--no-open", "Print the URL without opening it")
    .action(async (id: string | undefined, o: { open: boolean }) => {
      const h = pick(id, "no linux host registered");
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      const { ensureVncTunnel } = await import("../browser/liveView.js");
      try {
        const v = await ensureVncTunnel(toRemoteHost(up));
        console.log(`${OK} VNC is up${v.tunnelPid ? ` (tunnel pid ${v.tunnelPid})` : " (reusing the existing tunnel)"}`);
        console.log(`  ${fmt.highlight(v.url)}`);
        console.log(fmt.muted("  the whole display, with mouse and keyboard — for a page's own sign-in, prefer the CONTROL button in the session's browser view"));
        if (o.open) {
          try { execFileSync("open", [v.url], { stdio: "ignore", timeout: 10_000 }); } catch { /* headless shell */ }
        }
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("shot [id]")
    .description("One screenshot of the host's screen, saved locally")
    .action(async (id: string | undefined) => {
      const h = pick(id, "no linux host registered");
      const up = await ensureUp(h, (m) => console.log(fmt.muted(`  ${m}`)));
      const { machineShot } = await import("../browser/liveView.js");
      try {
        console.log(machineShot(toRemoteHost(up)));
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("sleep [id]")
    .description("Stop a host so it stops costing money")
    .action((id: string | undefined) => {
      const h = pick(id, "no stoppable host registered");
      try {
        stopHost(h);
        console.log(`${OK} ${h.id} is stopping — it will cost only its disk until something wakes it`);
      } catch (err) {
        die((err as Error).message);
      }
    });

  hosts
    .command("rm <id>")
    .description("Forget a host — the registry entry only, the instance is untouched")
    .option("--force", "Remove it even while it is awake")
    .action((id: string, o: { force?: boolean }) => {
      const rows = readHosts();
      const h = rows.find((r) => r.id === id);
      if (!h) die(`no host ${id} is registered`, "`cast hosts ls` to see what is");
      if (!o.force) {
        let state: HostState | null = null;
        try { state = hostState(h).state; } catch { /* unreadable: let the removal through */ }
        if (state === "running") {
          die(
            `${id} is awake — removing it now would leave it running and billing with nothing tracking it`,
            "put it to sleep first (`cast hosts sleep`), or pass --force",
          );
        }
      }
      writeHosts(rows.filter((r) => r.id !== id));
      console.log(`${OK} forgot ${id} — the EC2 instance itself still exists; delete it in AWS if you meant that`);
    });

  return hosts;
}

/** Mount the group at the top level as `cast hosts`. */
export function registerHostsCommand(program: Command): Command {
  return buildHostsCommand(program);
}
