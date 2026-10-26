/**
 * `cast devices`: the machines on your account and the ones your teams opened
 * to you, and everything Settings > Machines and Agent features do to them,
 * from the shell. Each verb calls the same server function the web's control
 * does (devices.ts), so the two cannot disagree about what a change means.
 */

import type { Command } from "commander";
import {
  CLOUD_AGENT_PROVIDERS,
  PROVIDER_KEYS,
  STALE_MACHINE_MS,
  cloudAgentSetupSentence,
  cliErrorMessage,
  deviceDisplayName,
  getProviderKeySpec,
  isMachineSetting,
  machineOutOfService,
  snippetBySlug,
  type AgentToolSetupStatus,
} from "@codecast/shared/contracts";
import { commandGroup } from "../commandGroups.js";
import { fmt, icons } from "../colors.js";
import { formatAgeShort } from "../publishCommand.js";
import { convexClient } from "../remote/convexClient.js";
import { deviceId as localDeviceId } from "../remote/device.js";
import { requireDestructiveConfirm } from "../destructiveCommands.js";
import { promptHiddenSecret } from "../hiddenSecret.js";
import { encryptProviderKey } from "../providerKeyCrypto.js";
import { deviceLine, pickDevice } from "./resolve.js";

export type Team = { _id: string; name: string; role?: string };

export type Backend = { client: any; token: string; api: any };

export function die(message: string): never {
  console.error(fmt.error(message));
  process.exit(1);
}

/** The signed-in client, with every server refusal printed as its one sentence (cliErrorMessage) rather than a request id and stack. */
export async function backend(): Promise<Backend> {
  let b: Backend;
  try {
    b = await convexClient();
  } catch {
    die("not signed in on this machine: run `cast login` first");
  }
  const said = <T>(p: Promise<T>): Promise<T> => p.catch((err) => die(cliErrorMessage(err)));
  const client = {
    query: (fn: any, args: any) => said(b.client.query(fn, args)),
    mutation: (fn: any, args: any) => said(b.client.mutation(fn, args)),
  };
  return { ...b, client };
}

const ownDevices = (b: Backend): Promise<any[]> => b.client.query(b.api.devices.listDevices, { api_token: b.token });
const teamMachines = (b: Backend): Promise<any[]> => b.client.query(b.api.devices.listAgentBoxes, { api_token: b.token });
export const myTeams = async (b: Backend): Promise<Team[]> =>
  ((await b.client.query(b.api.teams.getUserTeams, { api_token: b.token })) ?? []).map((t: any) => ({ _id: String(t._id), name: t.name, role: t.role }));

/** One of your own machines by name; exits with the candidates when the name is not exactly one. */
async function ownDevice(b: Backend, needle: string): Promise<any> {
  const r = pickDevice(await ownDevices(b), needle, "machine of yours");
  if ("error" in r) die(r.error);
  return r.device;
}

/** Teams by name or id. None named: your only team, or an error naming them all. */
export function pickTeams(teams: Team[], names: string[]): Team[] {
  if (teams.length === 0) die("you are on no team");
  if (names.length === 0) {
    if (teams.length === 1) return teams;
    die(`you are on ${teams.length} teams; name one:\n${teams.map((t) => `  ${t.name}`).join("\n")}`);
  }
  return names.map((n) => {
    const q = n.toLowerCase();
    const exact = teams.filter((t) => t._id === n || t.name.toLowerCase() === q);
    const hits = exact.length ? exact : teams.filter((t) => t.name.toLowerCase().includes(q));
    if (hits.length !== 1) die(`${hits.length ? `"${n}" names ${hits.length} teams` : `no team of yours matches "${n}"`}:\n${(hits.length ? hits : teams).map((t) => `  ${t.name}`).join("\n")}`);
    return hits[0];
  });
}

/** Pad to a visible width: colour codes take no columns. */
const pad = (text: string, width: number) => text + " ".repeat(Math.max(1, width - text.replace(/\x1b\[[0-9;]*m/g, "").length));

/** Names for a list: the display name, plus the hostname where two machines would otherwise read the same. */
function listNames(rows: any[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const d of rows) counts.set(deviceDisplayName(d), (counts.get(deviceDisplayName(d)) ?? 0) + 1);
  return new Map(rows.map((d) => {
    const name = deviceDisplayName(d);
    return [d.device_id, (counts.get(name) ?? 0) > 1 && d.hostname && d.hostname !== name ? `${name} ${fmt.muted(d.hostname)}` : name];
  }));
}

const seen = (d: any) => (d.online ? fmt.success("online") : fmt.muted(`${formatAgeShort(Date.now() - d.last_seen)} ago`));

function version(d: any): string {
  if (!d.cli_version) return fmt.muted("—");
  if (d.update_required) return fmt.error(`${d.cli_version} (below floor)`);
  if (d.update_available) return fmt.warning(`${d.cli_version} (update)`);
  return d.cli_version;
}

/** Wait for the daemon's answer to a watched command, up to `seconds`. */
async function awaitOutcome(b: Backend, commandId: string, seconds: number): Promise<any | null> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const out = await b.client.query(b.api.devices.watchedCommandOutcome, { api_token: b.token, command_id: commandId });
    if (out && out.state !== "pending") return out;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/** The daemon's answer, or a line saying it has not answered and the command is still queued. */
async function reportOutcome(b: Backend, d: any, commandId: string, seconds: number, json: boolean, render: (out: any) => void): Promise<void> {
  const out = seconds > 0 ? await awaitOutcome(b, commandId, seconds) : null;
  if (json) { console.log(JSON.stringify({ command_id: commandId, outcome: out })); return; }
  if (!out) {
    console.log(`${fmt.warning("queued")} ${deviceDisplayName(d)} has not answered${d.online ? "" : " (offline)"}; it runs when the daemon next reads its commands`);
    return;
  }
  if (out.state === "failed") die(`${deviceDisplayName(d)}: ${out.error}`);
  render(out);
}

function printSetup(s: AgentToolSetupStatus): void {
  const mark = (ok: boolean, label: string) => `${ok ? fmt.success(icons.check) : fmt.error(icons.cross)} ${label}`;
  console.log(`${s.tool}: ${s.ready ? fmt.success("ready") : fmt.warning("not ready")}`);
  if (s.tool === "browser") {
    console.log(`  ${mark(s.chrome_running, "Chrome running")}  ${mark(s.paired, "extension paired")}  ${mark(s.connected, "connected")}`);
  } else {
    console.log(`  ${mark(s.supported, "supported")}  ${mark(s.accessibility, "Accessibility")}  ${mark(s.screen_recording, "Screen Recording")}`);
  }
  if (s.detail) console.log(`  ${fmt.muted(s.detail)}`);
}

function sharedNames(d: any, teams: Team[]): string {
  return (d.shared_team_ids ?? []).map((id: string) => teams.find((t) => t._id === id)?.name ?? id.slice(0, 8)).join(", ");
}

export function registerDevicesCommand(program: Command): void {
  const devices = program
    .command("devices")
    .alias("machines")
    .description(commandGroup("devices").description);

  devices
    .command("ls", { isDefault: true })
    .alias("list")
    .description("Your machines and the team machines opened to you: state, version, sharing")
    .option("--json", "Machine-readable")
    .action(async (o: { json?: boolean }) => {
      const b = await backend();
      const [own, team, teams] = await Promise.all([ownDevices(b), teamMachines(b), myTeams(b)]);
      if (o.json) { console.log(JSON.stringify({ this_device: localDeviceId(), devices: own, team_machines: team, teams }, null, 2)); return; }
      const here = localDeviceId();
      const now = Date.now();
      const sorted = [...own].sort((a, b2) => Number(b2.online) - Number(a.online) || b2.last_seen - a.last_seen);
      const names = listNames([...own, ...team]);
      const line = (d: any, tail: string) =>
        console.log(`  ${fmt.id(d.device_id.slice(0, 8))}  ${pad(names.get(d.device_id)!, 44)}${pad(d.platform, 7)}${pad(version(d), 19)}${pad(seen(d), 14)}${tail}`);
      console.log(fmt.highlight(`Your machines`) + fmt.muted(`  ${own.filter((d) => d.online).length} of ${own.length} online`));
      for (const d of sorted) {
        const tags = [
          d.device_id === here ? fmt.accent("this machine") : "",
          d.is_remote ? "cloud" : "",
          machineOutOfService(d, own, now) ? fmt.muted("inactive") : "",
          (d.shared_team_ids?.length ?? 0) ? fmt.accent(`shared: ${sharedNames(d, teams)}`) : "",
        ].filter(Boolean).join("  ");
        line(d, tags);
      }
      if (team.length) {
        console.log("\n" + fmt.highlight("Team machines") + fmt.muted("  sessions you start here run as their owner"));
        for (const t of team) {
          const owner = t.is_bot ? `bot ${t.bot_name ?? ""}` : (t.runner_name ?? "a teammate");
          const teamName = teams.find((x) => x._id === String(t.team_id))?.name ?? "";
          line(t, fmt.muted(`${owner} · ${teamName}`));
        }
      }
      const stale = own.filter((d) => !d.online && machineOutOfService(d, own, now));
      if (stale.length) console.log(fmt.muted(`\n${stale.length} inactive (not seen in ${STALE_MACHINE_MS / 3_600_000}h): cast devices rm --stale`));
    });

  devices
    .command("show <device>")
    .description("One machine in full: version, sharing, settings, keys, repos, checkouts")
    .option("--json", "Machine-readable")
    .action(async (needle: string, o: { json?: boolean }) => {
      const b = await backend();
      const [own, team, teams] = await Promise.all([ownDevices(b), teamMachines(b), myTeams(b)]);
      const r = pickDevice([...own, ...team.filter((t) => !own.some((d) => d.device_id === t.device_id))], needle);
      if ("error" in r) die(r.error);
      const d = r.device;
      if (o.json) { console.log(JSON.stringify(d, null, 2)); return; }
      const row = (k: string, v: string) => console.log(`  ${fmt.label(k.padEnd(12))} ${v}`);
      console.log(fmt.highlight(deviceDisplayName(d)));
      row("id", d.device_id);
      row("platform", `${d.platform}${d.is_remote ? " (cloud host)" : ""}${d.hostname ? `  ${d.hostname}` : ""}`);
      row("state", seen(d));
      row("version", version(d));
      if (d.ssh_host) row("ssh", d.ssh_host);
      if (d.owner_user_id) {
        row("owner", d.is_bot ? `bot ${d.bot_name ?? ""}` : (d.runner_name ?? "a teammate"));
        row("via team", teams.find((t) => t._id === String(d.team_id))?.name ?? String(d.team_id));
        return;
      }
      row("shared", (d.shared_team_ids?.length ?? 0) ? sharedNames(d, teams) : fmt.muted("private"));
      const s = d.settings ?? {};
      const on = Object.entries(s.snippets ?? {}).filter(([, v]) => v).map(([k]) => k);
      row("settings", [
        `hooks ${s.hooks_enabled === false ? "off" : "on"}`,
        `auto-update ${s.auto_update === false ? "off" : "on"}`,
        `stable ${s.stable_mode ?? "off"}${s.stable_global ? " (global)" : ""}`,
      ].join(", "));
      if (on.length) row("snippets", on.join(", "));
      row("keys", (d.managed_provider_ids?.length ?? 0) ? d.managed_provider_ids.join(", ") : fmt.muted("none managed"));
      for (const blk of d.cloud_agent_blocks ?? []) {
        const spec = (CLOUD_AGENT_PROVIDERS as Record<string, any>)[blk.provider];
        row("cloud agent", fmt.warning(spec ? cloudAgentSetupSentence(spec, blk, deviceDisplayName(d)) : `${blk.provider}: ${blk.kind.replace(/_/g, " ")}${blk.reason ? ` (${blk.reason})` : ""}`));
      }
      if (d.pending_sync_count) row("sync", fmt.warning(`${d.pending_sync_count} pending`));
      if (d.loop_freeze_1h_ms) row("freezes", `${Math.round(d.loop_freeze_1h_ms / 1000)}s in the last hour${d.loop_freeze_top ? ` (${d.loop_freeze_top})` : ""}`);
      for (const g of d.git_plane ?? []) {
        const state = g.needs_access ? fmt.warning("needs access") : !g.origin_ok ? fmt.error("no usable origin") : g.fetch_ok === false ? fmt.error("fetch failing") : fmt.success("ok");
        row("repo", `${g.root}  ${g.branch ?? ""} ${state}`);
      }
      if (d.git_pubkey && (d.git_plane ?? []).some((g: any) => g.needs_access)) row("git key", d.git_pubkey);
      row("checkouts", String(d.local_project_roots?.length ?? 0));
    });

  devices
    .command("share <device> [teams...]")
    .description("Open one of your machines to a team: teammates can start sessions on it, which run as you")
    .option("--yes", "Skip the confirmation")
    .action(async (needle: string, names: string[], o: { yes?: boolean }) => {
      const b = await backend();
      const d = await ownDevice(b, needle);
      const add = pickTeams(await myTeams(b), names);
      await requireDestructiveConfirm(["devices", "share"], { yes: o.yes, args: [needle, ...names] });
      const next = [...new Set([...(d.shared_team_ids ?? []), ...add.map((t) => t._id)])];
      await b.client.mutation(b.api.devices.setDeviceShares, { api_token: b.token, device_id: d.device_id, team_ids: next });
      console.log(`${fmt.success("ok")} ${add.map((t) => t.name).join(", ")} can start sessions on ${deviceDisplayName(d)}; they run as you`);
    });

  devices
    .command("unshare <device> [teams...]")
    .description("Close one of your machines to a team (every team when none is named)")
    .action(async (needle: string, names: string[]) => {
      const b = await backend();
      const d = await ownDevice(b, needle);
      const teams = await myTeams(b);
      const drop = names.length ? new Set(pickTeams(teams, names).map((t) => t._id)) : null;
      const next = drop ? (d.shared_team_ids ?? []).filter((id: string) => !drop.has(id)) : [];
      await b.client.mutation(b.api.devices.setDeviceShares, { api_token: b.token, device_id: d.device_id, team_ids: next });
      console.log(`${fmt.success("ok")} ${deviceDisplayName(d)} ${next.length ? `is shared with ${sharedNames({ shared_team_ids: next }, teams)} only` : "is private"}`);
    });

  devices
    .command("rm [devices...]")
    .alias("remove")
    .description("Remove offline machines from your list (sessions and transcripts stay; a daemon that runs again lists itself)")
    .option("--stale", "Every machine out of service: not seen in a day, or a cloud host whose instance is gone")
    .action(async (needles: string[], o: { stale?: boolean }) => {
      const b = await backend();
      const own = await ownDevices(b);
      const now = Date.now();
      const targets = o.stale
        ? own.filter((d) => !d.online && machineOutOfService(d, own, now))
        : needles.map((n) => { const r = pickDevice(own, n, "machine of yours"); if ("error" in r) die(r.error); return r.device; });
      if (!targets.length) { console.log(o.stale ? "no inactive machines" : "name machines to remove, or pass --stale"); return; }
      const res = await b.client.mutation(b.api.devices.removeDevices, { api_token: b.token, device_ids: targets.map((d: any) => d.device_id) });
      for (const id of res.removed) console.log(`${fmt.success("removed")} ${deviceLine(own.find((d) => d.device_id === id) ?? { device_id: id })}`);
      for (const s of res.skipped) console.log(`${fmt.warning("kept")}    ${deviceLine(own.find((d) => d.device_id === s.device_id) ?? { device_id: s.device_id })}: ${s.reason === "online" ? "online; stop its daemon (cast stop) first" : s.reason}`);
      if (res.skipped.length) process.exitCode = 1;
    });

  devices
    .command("update [devices...]")
    .description("Update codecast on machines now (works with automatic update off)")
    .option("--all", "Every online machine of yours that is behind")
    .action(async (needles: string[], o: { all?: boolean }) => {
      const b = await backend();
      const own = await ownDevices(b);
      const targets = o.all
        ? own.filter((d) => d.online && (d.update_available || d.update_required))
        : needles.map((n) => { const r = pickDevice(own, n, "machine of yours"); if ("error" in r) die(r.error); return r.device; });
      if (!targets.length) { console.log(o.all ? "every online machine is current" : "name machines to update, or pass --all"); return; }
      for (const d of targets) {
        await b.client.mutation(b.api.devices.requestDeviceUpdate, { api_token: b.token, device_id: d.device_id });
        console.log(`${fmt.success("asked")} ${deviceLine(d)} (on ${d.cli_version ?? "unknown"}) to update${d.online ? "" : "; it runs when the machine is back"}`);
      }
    });

  devices
    .command("ssh-host <device> [host]")
    .description("How to reach a machine over ssh, for attach commands (omit host to clear); an admin may set a team agent box's")
    .action(async (needle: string, host: string | undefined) => {
      const b = await backend();
      const [own, team] = await Promise.all([ownDevices(b), teamMachines(b)]);
      const editable = [...own, ...team.filter((t) => t.can_edit && !own.some((d) => d.device_id === t.device_id))];
      const r = pickDevice(editable, needle, "machine you can edit");
      if ("error" in r) die(r.error);
      const d = r.device;
      const res = await b.client.mutation(b.api.devices.setDeviceSshHost, {
        api_token: b.token,
        device_id: d.device_id,
        ssh_host: host ?? "",
        ...(d.owner_user_id ? { owner_user_id: d.owner_user_id } : {}),
      });
      console.log(res.ssh_host ? `${fmt.success("ok")} ${deviceDisplayName(d)}: ssh ${res.ssh_host}` : `${fmt.success("ok")} cleared ${deviceDisplayName(d)}'s ssh host`);
    });

  devices
    .command("set <device> <setting> <value>")
    .description("Turn a snippet or machine setting on or off on a machine (hooks, auto_update, session_trailer, any `cast install` snippet), or set stable to solo|team|off")
    .option("--global", "stable only: inject in every project, not just this one")
    .action(async (needle: string, setting: string, value: string, o: { global?: boolean }) => {
      const b = await backend();
      const d = await ownDevice(b, needle);
      const v = value.toLowerCase();
      let args: Record<string, unknown>;
      if (setting === "stable") {
        if (!["solo", "team", "off"].includes(v)) die("stable takes solo, team or off");
        args = { snippet: "stable", enabled: v !== "off", mode: v, global: !!o.global };
      } else {
        const name = isMachineSetting(setting) ? setting : snippetBySlug(setting)?.slug;
        if (!name) die(`unknown setting "${setting}": hooks, auto_update, session_trailer, stable, or a snippet (cast install --help lists them)`);
        if (!["on", "off", "true", "false"].includes(v)) die("value is on or off");
        args = { snippet: name, enabled: v === "on" || v === "true" };
      }
      await b.client.mutation(b.api.devices.setDeviceSnippet, { api_token: b.token, device_id: d.device_id, ...args });
      console.log(`${fmt.success("ok")} ${setting} ${v} on ${deviceDisplayName(d)}${d.online ? "" : fmt.warning(" (offline: lands only if it is back within 5 minutes)")}`);
    });

  devices
    .command("key <device> <op> <provider>")
    .description(`Set or remove a provider API key on a machine (op: set|rm); the key is sealed to that machine and never reaches the server readable. Providers: ${PROVIDER_KEYS.map((p) => p.id).join(", ")}`)
    .option("--wait <seconds>", "How long to wait for the machine to check the key", "30")
    .option("--json", "Machine-readable")
    .action(async (needle: string, op: string, provider: string, o: { wait: string; json?: boolean }) => {
      const spec = getProviderKeySpec(provider);
      if (!spec) die(`unknown provider "${provider}": ${PROVIDER_KEYS.map((p) => p.id).join(", ")}`);
      if (op !== "set" && op !== "rm") die("op is set or rm");
      const b = await backend();
      const d = await ownDevice(b, needle);
      if (op === "rm") {
        await b.client.mutation(b.api.devices.enqueueProviderKeyCommand, { api_token: b.token, device_id: d.device_id, op: "remove", provider: spec.id });
        console.log(`${fmt.success("ok")} removing the ${spec.label} key from ${deviceDisplayName(d)}`);
        return;
      }
      if (!d.provider_key_pubkey) die(`${deviceDisplayName(d)} runs a codecast too old to receive keys; cast devices update ${d.device_id.slice(0, 8)}`);
      const key = (await promptHiddenSecret(`Paste ${spec.label} API key for ${deviceDisplayName(d)} (hidden): `)).trim();
      if (!key) die("no key given");
      const payload = encryptProviderKey(d.provider_key_pubkey, spec.id, key);
      const res = await b.client.mutation(b.api.devices.enqueueProviderKeyCommand, { api_token: b.token, device_id: d.device_id, op: "set", provider: spec.id, payload });
      await reportOutcome(b, d, res.command_id, Number(o.wait) || 0, !!o.json, (out) =>
        console.log(`${fmt.success("ok")} ${spec.label} key set on ${deviceDisplayName(d)}${out.account ? ` (${out.account})` : ""}${out.detail ? `\n  ${fmt.warning(out.detail)}` : ""}`));
    });

  devices
    .command("login <device> <provider>")
    .description(`Check or start a cloud agent sign-in on a machine (${Object.keys(CLOUD_AGENT_PROVIDERS).join(", ")}); starting prints the page and code to finish it anywhere`)
    .option("--start", "Start a sign-in rather than check the current one")
    .option("--wait <seconds>", "How long to wait for the machine's answer", "60")
    .option("--json", "Machine-readable")
    .action(async (needle: string, provider: string, o: { start?: boolean; wait: string; json?: boolean }) => {
      if (!Object.prototype.hasOwnProperty.call(CLOUD_AGENT_PROVIDERS, provider)) die(`unknown provider "${provider}": ${Object.keys(CLOUD_AGENT_PROVIDERS).join(", ")}`);
      const b = await backend();
      const d = await ownDevice(b, needle);
      const res = await b.client.mutation(b.api.devices.enqueueCloudAgentLoginCommand, {
        api_token: b.token, device_id: d.device_id, provider, op: o.start ? "start" : "check", ...(o.start ? { device_code: true } : {}),
      });
      await reportOutcome(b, d, res.command_id, Number(o.wait) || 0, !!o.json, (out) => {
        if (out.login) console.log(`${provider} on ${deviceDisplayName(d)}: ${out.login === "signed_in" ? fmt.success("signed in") : fmt.warning(out.login.replace("_", " "))}${out.account ? ` (${out.account})` : ""}`);
        if (out.url) console.log(`  open ${out.url}${out.detail ? ` and enter ${fmt.highlight(out.detail)}` : ""}`);
        else if (out.detail) console.log(`  ${out.detail}`);
      });
    });

  devices
    .command("setup <device> <tool>")
    .description("Check or start a machine's setup for agent tools: browser (the Chrome extension) or computer (macOS grants)")
    .option("--start", "Open the next setup step on that machine's screen")
    .option("--wait <seconds>", "How long to wait for the machine's answer", "30")
    .option("--json", "Machine-readable")
    .action(async (needle: string, tool: string, o: { start?: boolean; wait: string; json?: boolean }) => {
      if (tool !== "browser" && tool !== "computer") die("tool is browser or computer");
      const b = await backend();
      const d = await ownDevice(b, needle);
      const res = await b.client.mutation(b.api.devices.enqueueAgentToolSetupCommand, { api_token: b.token, device_id: d.device_id, tool, op: o.start ? "start" : "check" });
      await reportOutcome(b, d, res.command_id, Number(o.wait) || 0, !!o.json, (out) => {
        if (out.setup) printSetup(out.setup);
        else console.log(`${fmt.success("ok")} ${out.detail ?? `${tool} setup sent to ${deviceDisplayName(d)}`}`);
      });
    });
}
