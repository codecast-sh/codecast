// Cast machines' AWS side: the fixed names, the EC2 calls and the wake
// target lookup. A leaf (no Convex functions), so cloudWake.ts and
// castMachines.ts can both import it.
import { signEc2Request, type AwsWakeCredentials, type CloudWakeHost } from "../cloudWakeAws";

export const CAST_MACHINE_REGION = "us-west-2";
export const CAST_MACHINE_LAUNCH_TEMPLATE = "cast-user-machine";
export const CAST_MACHINE_TAG = { Key: "codecast-role", Value: "cast-user-machine" } as const;
/** Machines running at once, across everyone: 20 t3.small = 40 vCPU. */
export const CAST_MACHINE_MAX_RUNNING = 20;

export function castCredentials(): AwsWakeCredentials | null {
  const accessKeyId = process.env.CAST_MACHINES_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CAST_MACHINES_AWS_SECRET_ACCESS_KEY;
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null;
}

/** The wake target for a device, when it is a cast machine (cloudWake.ts). */
export async function castMachineWakeHost(ctx: { db: any }, ownerUserId: string, deviceId: string): Promise<CloudWakeHost | undefined> {
  const row = await ctx.db.query("cast_machines").withIndex("by_device", (q: any) =>
    q.eq("user_id", ownerUserId).eq("device_id", deviceId)).first();
  return row?.instance_id ? { ownerUserId, deviceId, instanceId: row.instance_id, region: row.region } : undefined;
}

// ---------------------------------------------------------------------------
// EC2 calls
// ---------------------------------------------------------------------------

export class Ec2Error extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function ec2(params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<string> {
  const creds = castCredentials();
  if (!creds) throw new Ec2Error("MissingCredentials");
  const req = await signEc2Request(CAST_MACHINE_REGION, creds, new URLSearchParams({ Version: "2016-11-15", ...params }), new Date());
  const res = await fetchImpl(req.url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(20_000) });
  const xml = await res.text();
  if (!res.ok) throw new Ec2Error(/<Code>([A-Za-z0-9.]+)<\/Code>/.exec(xml)?.[1] ?? `HTTP${res.status}`);
  return xml;
}

/** Cast machines pending or running right now, by AWS's own count. */
export async function runningCastMachines(fetchImpl?: typeof fetch): Promise<number> {
  const xml = await ec2({
    Action: "DescribeInstances",
    "Filter.1.Name": `tag:${CAST_MACHINE_TAG.Key}`, "Filter.1.Value.1": CAST_MACHINE_TAG.Value,
    "Filter.2.Name": "instance-state-name", "Filter.2.Value.1": "pending", "Filter.2.Value.2": "running",
  }, fetchImpl);
  return new Set(xml.match(/<instanceId>i-[0-9a-f]+<\/instanceId>/g) ?? []).size;
}

/** Whether one more machine may start; the wake path asks before StartInstances. */
export async function castMachineCapacityLeft(fetchImpl?: typeof fetch): Promise<boolean> {
  return (await runningCastMachines(fetchImpl)) < CAST_MACHINE_MAX_RUNNING;
}

