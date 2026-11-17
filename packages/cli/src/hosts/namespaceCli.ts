import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { Command } from "commander";
import { agentSpawnPath } from "../agentSpawnPath.js";
import { readHosts, upsertHost, type CloudHost } from "../browser/cloudHost.js";
import { fmt, icons } from "../colors.js";
import { whichBin } from "../proc.js";
import { shellWord } from "../remote/session-move.js";
import { RUN_LIMIT_WARN_MINUTES, runEndsAt, runMinutesLeft } from "@codecast/shared/contracts";
import { formatDuration } from "@codecast/shared/time";
import { checkIdleMinutes, provisionArgv, type CreateHostOptions } from "./create.js";
import { devbox, devboxList, namespaceDescribe, namespaceKeyPath, NamespaceCliFailed, type DevboxInfo } from "./providers/namespace.js";

export const DEVBOX_SIZES = ["s", "m", "l", "xl"];
export const NAMESPACE_IDLE_STOP = "5m";

export type NamespaceFlags = Partial<CreateHostOptions> & { maxRun?: string; serviceUser?: string };

const AWS_ONLY_FLAGS = ["like", "key", "keyName", "image", "subnet", "securityGroup", "dedicatedHost", "profile", "user", "disk", "serviceUser"] as const;

export function parseMaxRun(duration: string): number {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(duration);
  const minutes = m ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : 0;
  if (minutes <= 0) throw new Error(`--max-run is a duration such as 4h, 90m or 1h30m, not "${duration}"`);
  if (minutes <= RUN_LIMIT_WARN_MINUTES) throw new Error(`--max-run must be longer than ${RUN_LIMIT_WARN_MINUTES} minutes, the point where the run-limit warning starts: "${duration}" would be inside the warning from the first minute`);
  return minutes;
}

function refuseAwsFlags(o: NamespaceFlags): void {
  const given = AWS_ONLY_FLAGS.filter((k) => o[k] !== undefined);
  if (given.length) throw new Error(`${given.map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(", ")} ${given.length === 1 ? "does" : "do"} not apply to --provider namespace`);
}

export function namespaceHost(box: DevboxInfo, previous: CloudHost | undefined, maxRun: string | undefined): CloudHost {
  const bin = whichBin("devbox", agentSpawnPath());
  if (!bin) throw new NamespaceCliFailed("the devbox CLI is not installed (or not on any known PATH) on this machine");
  return {
    ...previous,
    id: box.id, provider: "namespace", region: box.site ?? "", platform: "linux", user: "devbox",
    keyPath: namespaceKeyPath(box.name), address: box.name, proxyCommand: `${shellWord(bin)} ssh-proxy ${box.name}`,
    ...(maxRun !== undefined ? { maxRunMinutes: parseMaxRun(maxRun) } : {}),
  };
}

export async function addNamespaceHost(hosts: Command, name: string, o: NamespaceFlags & { provision?: boolean }): Promise<void> {
  refuseAwsFlags(o);
  const box = devboxList().find((b) => b.name === name);
  if (!box) throw new Error(`no Devbox named ${name} (devbox list)`);
  if (!fs.existsSync(namespaceKeyPath(name))) throw new Error(`no ssh key for ${name} at ${namespaceKeyPath(name)}: run \`devbox configure-ssh ${name}\``);
  const previous = readHosts().find((h) => h.id === box.id);
  const host = namespaceHost(box, previous, o.maxRun);
  upsertHost(host);
  console.log(`${fmt.success(icons.check)} registered ${host.id} (Linux, ${namespaceDescribe(host) ? "running" : "stopped"})`);
  if (o.provision) await hosts.parseAsync(provisionArgv(host.id, { idle: o.idle }), { from: "user" });
  else if (previous && o.maxRun !== undefined && host.maxRunMinutes !== previous.maxRunMinutes) console.log(fmt.muted(`the run limit is stored; \`cast hosts provision ${host.id}\` is needed for the host to enforce it`));
}

export async function createNamespaceHost(hosts: Command, platform: string, o: NamespaceFlags): Promise<void> {
  if (platform !== "linux") throw new Error("A Namespace Devbox is a Linux host: use `cast hosts create linux --provider namespace`");
  refuseAwsFlags(o);
  const name = o.name ?? `cast-${randomBytes(3).toString("hex")}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) throw new Error("Name must be 1–63 letters, numbers, dots, dashes or underscores");
  const size = o.type ?? "s";
  if (!DEVBOX_SIZES.includes(size)) throw new Error(`--type is a Devbox size for --provider namespace: ${DEVBOX_SIZES.join(", ")}`);
  if (o.maxRun !== undefined) parseMaxRun(o.maxRun);
  if (o.idle !== undefined) checkIdleMinutes(o.idle);
  const args = ["create", "--name", name, "--size", size, "--no_checkout", "--image", "builtin:default", "--auto_stop_idle_timeout", NAMESPACE_IDLE_STOP];
  if (o.dryRun) {
    console.log(JSON.stringify({ provider: "namespace", name, size, args: ["devbox", ...args] }, null, 2));
    return;
  }
  if (devboxList().some((b) => b.name === name)) throw new Error(`A Devbox named ${name} already exists: register it with cast hosts add --provider namespace ${name}`);
  devbox(args);
  const box = devboxList().find((b) => b.name === name);
  if (!box) throw new Error(`devbox created ${name} but it is not in devbox list; inspect it before retrying`);
  const host = namespaceHost(box, undefined, o.maxRun);
  upsertHost(host);
  console.log(`Registered ${host.id}. Resume setup with: cast hosts provision ${host.id}`);
  if (o.provision !== false) await hosts.parseAsync(provisionArgv(host.id, { idle: o.idle }), { from: "user" });
}

export interface RunLimit {
  maxMinutes: number;
  minutesLeft?: number;
}

export function hostRunLimit(host: CloudHost, startedAt: number | undefined, now = Date.now()): { runLimit?: RunLimit } {
  if (!host.maxRunMinutes) return {};
  const minutesLeft = startedAt === undefined ? undefined : runMinutesLeft(runEndsAt(startedAt, host.maxRunMinutes), now);
  return { runLimit: { maxMinutes: host.maxRunMinutes, ...(minutesLeft !== undefined ? { minutesLeft } : {}) } };
}

export function runLimitText(limit: RunLimit): string {
  const { maxMinutes, minutesLeft } = limit;
  const text = `limit ${formatDuration(maxMinutes * 60_000)}${minutesLeft === undefined ? "" : `, ${minutesLeft} min left`}`;
  return minutesLeft !== undefined && minutesLeft < RUN_LIMIT_WARN_MINUTES ? fmt.warning(text) : fmt.muted(text);
}
