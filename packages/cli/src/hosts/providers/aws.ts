import { agentSpawnPath } from "../../agentSpawnPath.js";
import type { CloudHost, HostState } from "../../browser/cloudHost.js";
import { execFileSync } from "../../proc.js";
import type { HostFacts, HostInspection, HostProvider } from "./types.js";

/** The aws CLI failed to RUN (not an AWS "no" — the binary or its execution). */
export class AwsCliFailed extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "AwsCliFailed";
  }
}

export function aws(args: string[], region: string, profile?: string): any {
  try {
    const out = execFileSync("aws", [...args, "--region", region, ...(profile ? ["--profile", profile] : []), "--output", "json"], {
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
      // agentSpawnPath, not process.env.PATH: under launchd the daemon gets a
      // bare system PATH, and a child that cannot find `aws` used to cascade
      // into "host no longer exists" (ENOENT → catch → "missing" → HostGone)
      // — a wrong diagnosis three layers from the cause. Seen live when the
      // web's "Move to Cloud Linux" ran this through the daemon.
      env: { ...process.env, PATH: agentSpawnPath(), AWS_PAGER: "" },
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (e.code === "ENOENT") {
      throw new AwsCliFailed("the aws CLI is not installed (or not on any known PATH) on this machine");
    }
    const stderr = String(e.stderr ?? "").trim();
    // The instance genuinely not existing is an ANSWER, not a failure —
    // callers map it to "missing". Everything else (bad credentials, expired
    // SSO, network) must surface as itself.
    if (/InvalidInstanceID\.NotFound/.test(stderr)) return null;
    throw new AwsCliFailed(stderr.split("\n")[0] || e.message || "aws CLI failed");
  }
}

export function instanceFacts(inst: any): HostFacts {
  const name = inst.State?.Name;
  const state: HostState =
    name === "running" ? "running" : name === "stopped" ? "stopped" : name === "terminated" ? "missing" : "pending";
  return { state, address: inst.PublicIpAddress };
}

export function ec2State(inst: any): HostFacts {
  return inst ? instanceFacts(inst) : { state: "missing" };
}

/** The instance's Name tag, the name a person gave the box (union-line-1), or undefined. */
export function instanceNameTag(inst: { Tags?: Array<{ Key?: string; Value?: string }> } | null | undefined): string | undefined {
  return inst?.Tags?.find((t) => t.Key === "Name")?.Value?.trim() || undefined;
}

export function ec2Inspection(inst: any, volumeGiB?: number): HostInspection {
  const name = instanceNameTag(inst);
  return { ...instanceFacts(inst), instanceType: inst.InstanceType, ...(name ? { name } : {}), platform: /^mac\d|^mac-/.test(inst.InstanceType ?? "") ? "darwin" : "linux", ...(volumeGiB === undefined ? {} : { volumeGiB }) };
}

export function awsDescribe(host: CloudHost): any {
  return aws(["ec2", "describe-instances", "--instance-ids", host.id], host.region, host.profile)?.Reservations?.[0]?.Instances?.[0];
}

function awsVolumeGiB(host: CloudHost): number | undefined {
  try {
    const vols = aws(
      ["ec2", "describe-volumes", "--filters", `Name=attachment.instance-id,Values=${host.id}`],
      host.region, host.profile,
    );
    const sizes: number[] = (vols?.Volumes ?? []).map((v: any) => Number(v.Size) || 0);
    if (sizes.length) return sizes.reduce((a, b) => a + b, 0);
  } catch { /* the disk size is the only field this loses */ }
  return undefined;
}

export const awsProvider: HostProvider = {
  images: true,
  clones: true,
  resizes: true,
  macOnly: false,
  describe: awsDescribe,
  state: (host) => ec2State(awsDescribe(host)),
  inspect(host) {
    const inst = awsDescribe(host);
    return inst ? ec2Inspection(inst, awsVolumeGiB(host)) : { state: "missing" };
  },
  stop(host) {
    aws(["ec2", "stop-instances", "--instance-ids", host.id], host.region, host.profile);
  },
  async start(host, hooks) {
    const { bootEc2 } = await import("./ec2Start.js");
    return bootEc2(host, {
      describe: () => awsDescribe(host),
      start: () => { aws(["ec2", "start-instances", "--instance-ids", host.id], host.region, host.profile); },
      healSecurityGroup: true,
    }, hooks);
  },
};
