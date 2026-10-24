/**
 * `cast hosts team`: team machines (docs/architecture/team-machines.md), a
 * Linux box a team owns where every member runs as their own Linux user,
 * daemon and Claude login.
 *
 * Three kinds of caller. The box's admin registers it, on the box. Members
 * list, join and sign in from anywhere (the web does the same through the
 * store). The admin daemon runs `apply` for each queued join or removal,
 * carrying it out on the box with the shared-host scripts.
 */
import { spawnSync } from "../proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import {
  TEAM_HOST_JOIN_STEP_LABELS,
  TEAM_HOST_JOIN_STEPS,
  formatTeamHostMarker,
  isLinuxUserName,
  type TeamHostJoinStep,
} from "@codecast/shared/contracts";
import { readTeamHostMarker } from "./teamMarker.js";
import { fmt, icons } from "../colors.js";
import { convexClient } from "../remote/convexClient.js";
import { defaultConfigDir } from "../config/configDir.js";
import { deviceId } from "../remote/device.js";
import { SHARED_HOST_MARKER } from "../remote/sharedHostGuard.js";
import { readInstalledClientVersions } from "../remote/agentAuth.js";
import { DAEMON_WANTED_FILE } from "../systemdDaemonUnit.js";
import {
  addUserRootScript,
  addUserSelfScript,
  enableUserDaemonScript,
  removeUserRootScript,
  sharedHostSetupScript,
  userToolPath,
} from "../browser/sharedHost.js";

const OK = fmt.success(icons.check);

function die(msg: string, hint?: string): never {
  console.error(`${fmt.error(icons.cross)} ${msg}`);
  if (hint) console.error(`  ${fmt.muted(hint)}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Member = {
  _id: string; user_id: string; name: string; linux_user: string; status: string; step?: string; error?: string;
  stalled?: boolean; device_id?: string; online: boolean; claude_signed_in: boolean; claude_email?: string;
  login_flow?: { status: string; url?: string; started_at: number; reason?: string };
  usage: { sessions: number; cpu: number; mem_gb: number } | null; is_admin: boolean;
};
type Machine = {
  _id: string; team_id: string; team_name: string; name: string; address?: string; platform: string;
  admin_name: string; admin_linux_user: string; admin_online: boolean; can_manage: boolean;
  load: { cpus: number; cpu_pct?: number; mem_free_gb: number; mem_total_gb: number; busy: boolean } | null;
  members: Member[];
};

async function backend() {
  try {
    return await convexClient();
  } catch {
    die("not signed in on this machine", "run `cast login` first");
  }
}

async function machines(b: Awaited<ReturnType<typeof backend>>): Promise<Machine[]> {
  return (await b.client.query(b.api.teamHosts.list, { api_token: b.token })) ?? [];
}

/** A machine by name (case-insensitive) or id prefix; exits naming the candidates otherwise. */
function pickMachine(all: Machine[], needle: string): Machine {
  const n = needle.trim().toLowerCase();
  const hits = all.filter((m) => m.name.toLowerCase() === n || m._id.startsWith(needle));
  const loose = hits.length ? hits : all.filter((m) => m.name.toLowerCase().includes(n));
  if (loose.length === 1) return loose[0];
  if (loose.length === 0) die(`no team machine named "${needle}"`, all.length ? `yours: ${all.map((m) => `"${m.name}"`).join(", ")}` : "none on your teams yet: the box's admin runs `cast hosts team register` there");
  die(`"${needle}" matches ${loose.length} team machines: ${loose.map((m) => `"${m.name}" (${m.team_name})`).join(", ")}`);
}

function myRow(m: Machine, userId: string): Member | undefined {
  return m.members.find((r) => r.user_id === userId && !r.is_admin) ?? m.members.find((r) => r.user_id === userId);
}

/** The backend this machine's own login talks to. */
function adminConvexUrl(): string | undefined {
  try {
    const url = JSON.parse(fs.readFileSync(path.join(defaultConfigDir(), "config.json"), "utf-8")).convex_url;
    return typeof url === "string" && /^https?:\/\/[A-Za-z0-9.:-]+\/?$/.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

function viewerId(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(defaultConfigDir(), "config.json"), "utf-8"));
    return String(cfg.user_id ?? "");
  } catch {
    return "";
  }
}

function stepLabel(step: string | undefined): string {
  return step && (TEAM_HOST_JOIN_STEPS as readonly string[]).includes(step) ? TEAM_HOST_JOIN_STEP_LABELS[step as TeamHostJoinStep] : step ?? "";
}

function memberState(r: Member): string {
  if (r.status === "joining") return r.stalled ? fmt.warning("join stalled") : fmt.muted(`joining: ${stepLabel(r.step)}`);
  if (r.status === "failed") return fmt.error(`join failed: ${r.error ?? "unknown"}`);
  if (r.status === "removing") return fmt.muted(r.error ? `removing: ${r.error}` : "removing");
  if (!r.online) return fmt.muted("offline");
  if (!r.claude_signed_in) return fmt.warning("needs Claude sign-in");
  return fmt.success("ready");
}

function runBash(script: string, opts: { asUser?: string; input?: string; timeoutMs?: number } = {}): string {
  const argv = opts.asUser ? ["sudo", "-n", "-u", opts.asUser, "-H", "bash", "-s"] : ["bash", "-s"];
  const r = spawnSync(argv[0], argv.slice(1), { input: script, encoding: "utf-8", timeout: opts.timeoutMs ?? 600_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    const tail = `${r.stderr ?? ""}\n${r.stdout ?? ""}`.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
    throw new Error(tail || `exited ${r.status ?? r.signal}`);
  }
  return r.stdout ?? "";
}

/** The box's public address, from EC2 metadata (IMDSv2), or undefined off EC2. */
async function ec2PublicAddress(): Promise<string | undefined> {
  try {
    const token = await (await fetch("http://169.254.169.254/latest/api/token", {
      method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" }, signal: AbortSignal.timeout(2000),
    })).text();
    const res = await fetch("http://169.254.169.254/latest/meta-data/public-ipv4", { headers: { "X-aws-ec2-metadata-token": token }, signal: AbortSignal.timeout(2000) });
    const ip = (await res.text()).trim();
    return res.ok && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : undefined;
  } catch {
    return undefined;
  }
}

/** This laptop's ssh public key, offered on join so a member can also ssh in. */
function laptopPubkey(): string | undefined {
  for (const name of ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"]) {
    try {
      const key = fs.readFileSync(path.join(os.homedir(), ".ssh", name), "utf-8").trim().split("\n")[0];
      if (key) return key;
    } catch { /* next */ }
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The admin daemon's work: one queued join or removal
// ---------------------------------------------------------------------------

/**
 * Carry out one member change on this box, as its admin. The admin daemon
 * runs this in a detached child for each `team_host_member` command; every
 * step reports, and a failure ends the join with the reason the member sees.
 */
export async function applyMemberChange(memberId: string, log: (m: string) => void = console.log): Promise<void> {
  const b = await backend();
  const claim = await b.client.mutation(b.api.teamHosts.claimMember, { api_token: b.token, member_id: memberId });
  const report = (args: { step?: string; error?: string; removed?: boolean }) =>
    b.client.mutation(b.api.teamHosts.reportMember, { api_token: b.token, member_id: memberId, ...args });
  if (claim.action !== "add" && claim.action !== "remove") {
    log(`nothing to do for ${memberId}: ${claim.action}`);
    return;
  }
  const user: string = claim.linux_user;
  if (!isLinuxUserName(user)) throw new Error(`not a Linux user name: ${user}`);
  try {
    if (claim.action === "remove") {
      log(`removing ${user}…`);
      runBash(removeUserRootScript(user), { timeoutMs: 120_000 });
      await report({ removed: true });
      log(`${user} removed (home kept)`);
      return;
    }
    // A Linux user signed in as someone else is theirs: never hand it to this member.
    const owner = runBash(`sudo cat /home/${user}/.codecast/config.json 2>/dev/null || true`, { timeoutMs: 30_000 }).trim();
    if (owner) {
      let ownerId = "";
      try { ownerId = String(JSON.parse(owner).user_id ?? ""); } catch { /* unreadable: treat as someone else's */ }
      if (ownerId !== String(claim.user_id)) throw new Error(`the Linux user ${user} on this machine belongs to another codecast account`);
    }
    log(`creating ${user}…`);
    runBash(addUserRootScript(user, claim.github, { pubkey: claim.ssh_pubkey, lenientKeys: true }), { timeoutMs: 120_000 });
    await report({ step: "tools" });
    log(`installing ${user}'s tools…`);
    runBash(addUserSelfScript(readInstalledClientVersions()), { asUser: user, timeoutMs: 1_200_000 });
    const units = runBash(enableUserDaemonScript(user), { timeoutMs: 60_000 });
    if (!units.includes("path=active")) throw new Error(`could not arm ${user}'s daemon: ${units.trim()}`);
    await report({ step: "login" });
    log(`signing ${user} in…`);
    // The voucher goes in on stdin: a command line is readable by every user
    // on the box. The member signs in to the backend this daemon talks to.
    const convexUrl = adminConvexUrl();
    runBash(`export PATH=${userToolPath(`/home/${user}`)}\nexport CODECAST_NO_AUTOSTART=1\n${convexUrl ? `export CONVEX_URL=${JSON.stringify(convexUrl)}\n` : ""}cast login - <<'VOUCHER' >/dev/null\n${claim.voucher}\nVOUCHER`, { asUser: user, timeoutMs: 120_000 });
    await report({ step: "daemon" });
    // Their daemon runs while this file exists (sharedHost.ts userDaemonUnits); its first beat makes them ready.
    runBash(`sudo install -m 600 -o ${user} -g ${user} /dev/null /home/${user}/.codecast/${DAEMON_WANTED_FILE}`, { timeoutMs: 30_000 });
    log(`${user} is on the machine; their daemon is starting`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await report({ error: message }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Claude sign-in on your device there, from a terminal
// ---------------------------------------------------------------------------

async function signInHere(b: Awaited<ReturnType<typeof backend>>, machineName: string): Promise<void> {
  const me = viewerId();
  const find = async () => {
    const m = pickMachine(await machines(b), machineName);
    return { m, row: myRow(m, me) };
  };
  const { m, row } = await find();
  if (!row?.device_id || row.status !== "ready") die(`you are not on ${m.name} yet`, `join first: cast hosts team join "${m.name}"`);
  if (!row.online) die(`your daemon on ${m.name} is offline`);
  await b.client.mutation(b.api.accountSwitch.requestLoginFlow, { api_token: b.token, device_id: row.device_id, open_browser: false, force: true });
  console.log(fmt.muted(`  starting the Claude sign-in on ${m.name}…`));
  let url: string | undefined;
  let startedAt = 0;
  for (let i = 0; i < 40 && !url; i++) {
    await sleep(1500);
    const flow = (await find()).row?.login_flow;
    if (flow?.status === "rejected") die(`the sign-in did not start: ${flow.reason ?? "unknown"}`);
    if (flow?.status === "pending" && flow.url) { url = flow.url; startedAt = flow.started_at; }
  }
  if (!url) die("the machine did not report a sign-in page in time", "try again, or run `claude auth login` there over ssh");
  console.log(`\n  Open this page, sign in with your Claude account, and paste the code it shows:\n\n    ${fmt.accent(url)}\n`);
  if (!process.stdin.isTTY) die("no terminal to paste the code into", `finish it in Settings → Team → Machines`);
  const { input } = await import("@inquirer/prompts");
  const code = (await input({ message: "Code:" })).trim();
  await b.client.mutation(b.api.accountSwitch.submitLoginCode, { api_token: b.token, device_id: row.device_id, started_at: startedAt, code });
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const r = (await find()).row;
    if (r?.login_flow?.status === "confirmed" || r?.claude_signed_in) {
      console.log(`${OK} signed in to Claude on ${m.name}${r.claude_email ? ` as ${r.claude_email}` : ""}`);
      return;
    }
    if (r?.login_flow?.status === "rejected") die(`the sign-in failed: ${r.login_flow.reason ?? "unknown"}`);
  }
  die("the sign-in did not confirm in time", `check: cast hosts team ls`);
}

// ---------------------------------------------------------------------------
// The command group
// ---------------------------------------------------------------------------

export function registerHostTeamCommand(hosts: Command): void {
  const team = hosts
    .command("team")
    .description("Team machines: a Linux box your team shares, where each member runs as their own user, daemon and Claude login");

  team
    .command("ls", { isDefault: true })
    .description("Team machines on your teams: members, their state, and the machine's load")
    .option("--json", "Machine-readable")
    .action(async (o: { json?: boolean }) => {
      const b = await backend();
      const all = await machines(b);
      if (o.json) { console.log(JSON.stringify(all, null, 2)); return; }
      if (all.length === 0) {
        console.log("No team machines on your teams.");
        console.log(fmt.muted("  On a shared Linux box, its admin runs: cast hosts team register --team <team>"));
        return;
      }
      const me = viewerId();
      for (const m of all) {
        const load = m.load
          ? `${m.load.cpu_pct !== undefined ? `${m.load.cpu_pct}% CPU of ${m.load.cpus}, ` : ""}${m.load.mem_free_gb} of ${m.load.mem_total_gb} GB free${m.load.busy ? ` ${fmt.warning("busy")}` : ""}`
          : fmt.muted("no recent load report");
        console.log(`${fmt.value(m.name)}  ${fmt.muted(`${m.team_name} · admin ${m.admin_name}${m.address ? ` · ${m.address}` : ""}`)}`);
        console.log(`  ${load}`);
        for (const r of m.members) {
          const usage = r.usage && r.usage.sessions > 0 ? fmt.muted(`${r.usage.sessions} ${r.usage.sessions === 1 ? "session" : "sessions"}, ${r.usage.cpu}% CPU, ${r.usage.mem_gb} GB`) : "";
          console.log(`  ${r.user_id === me ? "→" : " "} ${r.linux_user.padEnd(12)} ${r.name.padEnd(20)} ${memberState(r)} ${usage}`);
        }
        if (!myRow(m, me)) console.log(fmt.muted(`  join: cast hosts team join "${m.name}"`));
        if (!m.admin_online) console.log(fmt.warning(`  the admin daemon is offline: joins and removals wait for it`));
        console.log("");
      }
    });

  team
    .command("register")
    .description("Run ON the box, as its admin (the user with sudo): make it a team machine teammates can join from the app")
    .requiredOption("--team <team>", "The team that owns it (name or id)")
    .option("--name <name>", "What everyone sees it as (default: this machine's name)")
    .option("--address <address>", "How members reach it over ssh (default: its public EC2 address)")
    .action(async (o: { team: string; name?: string; address?: string }) => {
      if (process.platform !== "linux") die("a team machine is a Linux box: run this on it");
      if (spawnSync("sudo", ["-n", "true"]).status !== 0) die("this user has no passwordless sudo: run it as the box's admin (the provisioning user)");
      const b = await backend();
      const teams: Array<{ _id: string; name: string }> = (await b.client.query(b.api.teams.getUserTeams, { api_token: b.token })) ?? [];
      const n = o.team.toLowerCase();
      const hit = teams.filter((t) => t._id === o.team || t.name.toLowerCase() === n);
      if (hit.length !== 1) die(hit.length ? `"${o.team}" names ${hit.length} teams` : `you are not on a team named "${o.team}"`, `yours: ${teams.map((t) => t.name).join(", ") || "none"}`);
      console.log(fmt.muted("  shared host setup: per-user daemon units, the marker…"));
      try {
        const out = runBash(sharedHostSetupScript(), { timeoutMs: 120_000 });
        if (!out.includes("SHARED-HOST-OK")) die(`shared host setup did not complete:\n${out.slice(-400)}`);
      } catch (err) {
        die(`shared host setup failed: ${(err as Error).message}`);
      }
      const existing = readTeamHostMarker() ?? {};
      const linuxUser = os.userInfo().username;
      const name = o.name ?? process.env.CODECAST_DEVICE_LABEL ?? os.hostname();
      const address = o.address ?? await ec2PublicAddress();
      const r = await b.client.mutation(b.api.teamHosts.register, {
        api_token: b.token, team_id: hit[0]._id, name, device_id: deviceId(), linux_user: linuxUser,
        platform: process.platform, ...(address ? { address } : {}), ...(existing.key ? { host_key: existing.key } : {}),
      });
      const marker = formatTeamHostMarker({ key: r.host_key, admin: linuxUser, team: hit[0]._id });
      runBash(`sudo tee ${SHARED_HOST_MARKER}.new >/dev/null <<'MARKER'\n${marker}MARKER\nsudo chmod 644 ${SHARED_HOST_MARKER}.new && sudo mv -f ${SHARED_HOST_MARKER}.new ${SHARED_HOST_MARKER}`, { timeoutMs: 30_000 });
      console.log(`${OK} ${name} is a team machine of ${hit[0].name}${address ? ` (${address})` : ""}`);
      console.log(fmt.muted(`  teammates join from Settings → Team → Machines, or: cast hosts team join "${name}"`));
    });

  team
    .command("join <machine>")
    .description("Join a team machine: your own Linux user, tools, daemon and (next) Claude sign-in on it")
    .option("--as <linux-user>", "The Linux user to get (default: your GitHub login or email name)")
    .option("--no-key", "Do not install this laptop's ssh public key for you there")
    .option("--no-wait", "Queue the join and return")
    .action(async (machine: string, o: { as?: string; key: boolean; wait: boolean }) => {
      const b = await backend();
      const m = pickMachine(await machines(b), machine);
      const pubkey = o.key ? laptopPubkey() : undefined;
      const r = await b.client.mutation(b.api.teamHosts.join, { api_token: b.token, host_id: m._id, ...(o.as ? { linux_user: o.as } : {}), ...(pubkey ? { ssh_pubkey: pubkey } : {}) });
      console.log(`${OK} joining ${m.name} as ${r.linux_user}`);
      if (!m.admin_online) console.log(fmt.warning(`  ${m.admin_name}'s admin daemon there is offline: the join starts when it comes back`));
      if (!o.wait) return;
      const me = viewerId();
      let last = "";
      const deadline = Date.now() + 40 * 60_000;
      while (Date.now() < deadline) {
        await sleep(3000);
        const row = myRow(pickMachine(await machines(b), m._id), me);
        if (!row) die("the join was cancelled");
        const now = row.status === "joining" ? stepLabel(row.step) : row.status;
        if (now !== last) { console.log(fmt.muted(`  ${now}`)); last = now; }
        if (row.status === "failed") die(`the join failed: ${row.error ?? "unknown"}`, `try again: cast hosts team join "${m.name}"`);
        if (row.status === "ready" && row.online) {
          console.log(`${OK} you are on ${m.name} as ${row.linux_user}${m.address ? fmt.muted(`  (ssh ${row.linux_user}@${m.address})`) : ""}`);
          if (row.claude_signed_in) return;
          if (!process.stdin.isTTY) { console.log(fmt.muted(`  next: cast hosts team sign-in "${m.name}"`)); return; }
          await signInHere(b, m._id);
          return;
        }
      }
      die("the join did not finish in 40 minutes", "see where it stopped: cast hosts team ls");
    });

  team
    .command("sign-in <machine>")
    .description("Sign in to Claude on your user on a team machine, through a page you open anywhere")
    .action(async (machine: string) => {
      await signInHere(await backend(), machine);
    });

  team
    .command("leave <machine>")
    .description("Take yourself off a team machine: your daemon stops and your login is removed; your files stay")
    .action(async (machine: string) => {
      const b = await backend();
      const m = pickMachine(await machines(b), machine);
      const row = myRow(m, viewerId());
      if (!row) die(`you are not on ${m.name}`);
      await b.client.mutation(b.api.teamHosts.removeMember, { api_token: b.token, member_id: row._id });
      console.log(`${OK} leaving ${m.name}; ${m.admin_online ? "the machine removes you within a minute" : "the machine removes you when its admin daemon is back"}`);
    });

  team
    .command("remove <machine> <linux-user>")
    .description("Admin: take a member off a team machine (their files stay)")
    .action(async (machine: string, linuxUser: string) => {
      const b = await backend();
      const m = pickMachine(await machines(b), machine);
      const row = m.members.find((r) => r.linux_user === linuxUser);
      if (!row) die(`${m.name} has no member ${linuxUser}`, `members: ${m.members.map((r) => r.linux_user).join(", ")}`);
      await b.client.mutation(b.api.teamHosts.removeMember, { api_token: b.token, member_id: row._id });
      console.log(`${OK} removing ${linuxUser} (${row.name}) from ${m.name}`);
    });

  team
    .command("rename <machine> <name>")
    .description("Admin: rename a team machine for everyone")
    .action(async (machine: string, name: string) => {
      const b = await backend();
      const m = pickMachine(await machines(b), machine);
      await b.client.mutation(b.api.teamHosts.rename, { api_token: b.token, host_id: m._id, name });
      console.log(`${OK} ${m.name} is now ${name}`);
    });

  team
    .command("unregister <machine>")
    .description("Admin: stop offering a box as a team machine (members' daemons keep running until removed on the box)")
    .action(async (machine: string) => {
      const b = await backend();
      const m = pickMachine(await machines(b), machine);
      await b.client.mutation(b.api.teamHosts.unregister, { api_token: b.token, host_id: m._id });
      console.log(`${OK} ${m.name} is no longer a team machine`);
    });

  team
    .command("apply <member-id>", { hidden: true })
    .description("Admin daemon: carry out one queued join or removal on this box")
    .action(async (memberId: string) => {
      try {
        await applyMemberChange(memberId);
      } catch (err) {
        die((err as Error).message);
      }
    });
}
