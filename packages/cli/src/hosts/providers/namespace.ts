import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentSpawnPath } from "../../agentSpawnPath.js";
import type { CloudHost } from "../../browser/cloudHost.js";
import { execFile, execFileSync } from "../../proc.js";
import type { HostFacts, HostInspection, HostProvider } from "./types.js";

export class NamespaceCliFailed extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "NamespaceCliFailed";
  }
}

export const READ_TIMEOUT_MS = 30_000;
const ASYNC_READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 120_000;

function run(bin: "devbox" | "nsc", args: string[], timeout: number): string {
  try {
    return execFileSync(bin, args, {
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: agentSpawnPath() },
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (e.code === "ENOENT") throw new NamespaceCliFailed(`the ${bin} CLI is not installed (or not on any known PATH) on this machine`);
    throw new NamespaceCliFailed(String(e.stderr ?? "").trim().split("\n")[0] || e.message || `${bin} failed`);
  }
}

export const devbox = (args: string[], timeout = WRITE_TIMEOUT_MS): string => run("devbox", args, timeout);
export const nsc = (args: string[], timeout = WRITE_TIMEOUT_MS): string => run("nsc", args, timeout);

function json(bin: "devbox" | "nsc", out: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    throw new NamespaceCliFailed(`${bin} printed output that is not JSON: ${out.trim().slice(0, 80)}`);
  }
}

export interface DevboxInfo {
  id: string;
  name: string;
  site?: string;
  instance_shape?: { virtual_cpu?: number; memory_megabytes?: number };
}

export function devboxList(): DevboxInfo[] {
  const out = devbox(["list", "-o", "json"], READ_TIMEOUT_MS);
  const boxes = out.trim() ? json("devbox", out) : null;
  return Array.isArray(boxes) ? boxes : [];
}

export const namespaceKeyPath = (name: string): string => path.join(process.env.HOME || os.homedir(), ".namespace", "ssh", `${name}.devbox.namespace.key`);

const describeArgs = (host: CloudHost): string[] => ["list", "--label", `devbox.id=${host.id}`, "-o", "json"];

function firstInstance(out: string): any {
  const list = json("nsc", out);
  return Array.isArray(list) ? list[0] ?? null : null;
}

export function namespaceDescribe(host: CloudHost): any {
  return firstInstance(nsc(describeArgs(host), READ_TIMEOUT_MS));
}

export function namespaceDescribeAsync(host: CloudHost): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile("nsc", describeArgs(host), { encoding: "utf-8", timeout: ASYNC_READ_TIMEOUT_MS, env: { ...process.env, PATH: agentSpawnPath() } }, (err, stdout) => {
      if (err) return reject(new NamespaceCliFailed(err.message));
      try { resolve(firstInstance(stdout)); } catch (parseErr) { reject(parseErr); }
    });
  });
}

function lookup(host: CloudHost): { box?: DevboxInfo; inst: any } {
  const box = devboxList().find((b) => b.id === host.id);
  return { box, inst: box ? namespaceDescribe(host) : null };
}

function factsOf({ box, inst }: { box?: DevboxInfo; inst: any }): HostFacts {
  if (!box) return { state: "missing" };
  const startedAt = Date.parse(inst?.created_at);
  return inst
    ? { state: "running", address: box.name, ...(Number.isFinite(startedAt) ? { startedAt } : {}) }
    : { state: "stopped", address: box.name };
}

function inspect(host: CloudHost): HostInspection {
  const found = lookup(host);
  const shape = found.box?.instance_shape;
  return {
    ...factsOf(found),
    ...(found.box ? { name: found.box.name, platform: "linux" as const } : {}),
    ...(shape?.virtual_cpu && shape.memory_megabytes ? { instanceType: `${shape.virtual_cpu} vCPU / ${Math.round(shape.memory_megabytes / 1024)} GB` } : {}),
  };
}

export const namespaceProvider: HostProvider = {
  images: false,
  clones: false,
  resizes: false,
  macOnly: false,
  display: false,
  systemd: false,
  describe: namespaceDescribe,
  describeAsync: namespaceDescribeAsync,
  state: (host) => factsOf(lookup(host)),
  inspect,
  stop(host) {
    if (!host.address) throw new NamespaceCliFailed(`${host.id} has no box name recorded: cast hosts add --provider namespace <name>`);
    devbox(["stop", "--force", host.address]);
  },
  forget(host) {
    if (!host.address) return undefined;
    const key = namespaceKeyPath(host.address);
    const files = [key, key.replace(/\.key$/, ".ssh")];
    for (const file of files) fs.rmSync(file, { force: true });
    return `removed ${files.join(" and ")} (devbox configure-ssh ${host.address} restores them while the Devbox exists)`;
  },
  async start(host, hooks) {
    const { bootNamespace } = await import("./namespaceStart.js");
    return bootNamespace(host, hooks);
  },
};
