/**
 * `cast hosts resize`: change a Linux host's instance type. EC2 changes a
 * type only on a stopped instance, so this stops the host (ending every
 * session running on it), changes the type, and starts it again when it was
 * awake. Without --yes it prints what would happen and changes nothing.
 */

import type { Command } from "commander";
import { CLOUD_HOST_SIZES } from "@codecast/shared/contracts";
import { describeInstance, ensureUp, readHosts, stopHost, toRemoteHost, type CloudHost } from "../browser/cloudHost.js";
import { ssh } from "../remote/session-move.js";
import { readRepoNeed, tooSmallFor } from "../repoNeed.js";
import { cwdGitRoot } from "../cloud/hostGit.js";
import { aws } from "./image.js";

const HOURS_PER_MONTH = 730;

/** Memory in GB of the Linux types a host is likely to be or become. */
const MEMORY_GB: Record<string, number> = {
  "t3.micro": 1,
  "t3.small": 2,
  "t3.medium": 4,
  ...Object.fromEntries(CLOUD_HOST_SIZES.map((s) => [s.type, s.memory_gb])),
};

export interface ResizePlan {
  from: string;
  to: string;
  awake: boolean;
  /** What the change costs and gives, one line each. */
  lines: string[];
}

/** The resize as a person decides it. Pure over the registry entry, its EC2 description and the price table. */
export function resizePlan(host: CloudHost, inst: any, to: string, prices: Record<string, number>, opts: { sessions?: number; needBytes?: number } = {}): ResizePlan {
  if (host.provider !== "aws") throw new Error(`${host.id} is not an AWS host`);
  if (host.platform === "darwin") throw new Error(`${host.id} is a Mac on a dedicated host: its size is the dedicated host's, so resizing means a new host`);
  if (!inst) throw new Error(`AWS has no instance ${host.id}`);
  if (!/^[a-z0-9-]+\.[a-z0-9]+$/.test(to) || /^mac/.test(to)) throw new Error(`not a Linux instance type: ${to}`);
  const from = String(inst.InstanceType);
  const state = inst.State?.Name;
  if (state !== "running" && state !== "stopped") throw new Error(`${host.id} is ${state ?? "in an unknown state"}; resize it once it is running or stopped`);
  const awake = state === "running";
  const size = (t: string) => `${t} (${MEMORY_GB[t] !== undefined ? `${MEMORY_GB[t]} GB, ` : ""}${prices[t] !== undefined ? `$${prices[t]}/hour` : "rate unknown"})`;
  const lines = [`${size(from)} → ${size(to)}`];
  if (prices[from] !== undefined && prices[to] !== undefined) {
    const delta = (prices[to] - prices[from]) * HOURS_PER_MONTH;
    lines.push(`${delta >= 0 ? "+" : "-"}$${Math.abs(delta).toFixed(0)}/month if awake all month (it sleeps after ${host.idleStopMinutes ?? "its idle"} minutes idle, so it costs only the hours it is used)`);
  }
  if (opts.needBytes && MEMORY_GB[to] !== undefined) {
    const small = tooSmallFor({ memoryTotal: MEMORY_GB[to] * 1024 ** 3 * 0.96 }, { memoryBytes: opts.needBytes });
    if (small) lines.push(`still too small for this repo: ${small.replace(/^it has/, `${to} has`)}`);
  }
  if (awake) lines.push(`stops the host for about two minutes${opts.sessions ? `, ending the ${opts.sessions} agent session${opts.sessions === 1 ? "" : "s"} running on it` : ""}, then starts it again`);
  return { from, to, awake, lines };
}

/** Agent processes running on the host, the sessions a stop would end. */
function countAgents(host: CloudHost): number | undefined {
  try {
    return Number(ssh(toRemoteHost(host), "ps -eo comm= | grep -cxE 'claude|codex|gemini|grok|opencode' || true", 20_000).trim()) || 0;
  } catch {
    return undefined;
  }
}

export function registerHostResizeCommand(hosts: Command, prices: Record<string, number>): void {
  hosts.command("resize <id>")
    .description("Change a Linux host's instance type (stops it, ending its sessions, then starts it again)")
    .requiredOption("--type <type>", `Instance type, e.g. ${CLOUD_HOST_SIZES.map((s) => `${s.type} (${s.memory_gb} GB)`).join(", ")}`)
    .option("--yes", "Do it; without this, print what would happen")
    .action(async (id: string, o: { type: string; yes?: boolean }) => {
      const host = readHosts().find((h) => h.id === id);
      if (!host) throw new Error(`no registered host ${id} (cast hosts ls)`);
      const inst = describeInstance(host);
      if (inst?.InstanceType === o.type) { console.log(`${id} is already ${o.type}`); return; }
      const awake = inst?.State?.Name === "running";
      const plan = resizePlan(host, inst, o.type, prices, { sessions: awake ? countAgents(host) : undefined, needBytes: readRepoNeed(cwdGitRoot())?.memoryBytes });
      for (const line of plan.lines) console.log(`  ${line}`);
      if (!o.yes) { console.log(`Nothing changed. Run again with --yes to resize ${id}.`); return; }
      const opts = { region: host.region, profile: host.profile };
      if (plan.awake) {
        console.log(`stopping ${id}…`);
        stopHost(host);
        aws(opts, ["ec2", "wait", "instance-stopped", "--instance-ids", id]);
      }
      aws(opts, ["ec2", "modify-instance-attribute", "--instance-id", id, "--instance-type", `Value=${o.type}`]);
      console.log(`${id} is now ${o.type}`);
      if (plan.awake) {
        const up = await ensureUp(host, (m) => console.log(`  ${m}`));
        console.log(`${id} is awake again at ${up.address}`);
      }
    });
}
