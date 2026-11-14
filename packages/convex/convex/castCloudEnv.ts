// `cast cloud` on codecast's account: a laptop asks for a machine of its own,
// and this backend launches it in codecast's AWS account (the cast machines
// account, lib/castMachineAws.ts) from the `cast-cloud-env` launch template,
// with the laptop's public key authorized for the ubuntu login. From then on
// the laptop treats it as an ordinary registered host (provider "codecast")
// and reaches it over SSH; only the EC2 calls a host needs (describe, start,
// stop) come here, because the laptop holds no AWS keys for the account.
//
// One HTTP route, /cli/cast/env-machine, answers all four operations for the
// caller's own machine only. Its describe answer has the shape of `aws ec2
// describe-instances`, so the CLI's host code reads it unchanged.
//
// Guard rails, the same as cast machines: the person must be enabled
// (CAST_MACHINES_USERS), a hard cap on these machines running at once is
// checked against AWS before every launch and start, and the AWS keys can only
// touch instances carrying the role tag.
import { v } from "convex/values";
import { httpAction } from "./_generated/server";
import { internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { CAST_MACHINE_REGION, ec2, Ec2Error } from "./lib/castMachineAws";
import { castMachinesEnabledFor } from "./castMachines";

export const CAST_ENV_LAUNCH_TEMPLATE = "cast-cloud-env";
export const CAST_ENV_TAG = { Key: "codecast-role", Value: "cast-cloud-env" } as const;
/** These machines running at once, across everyone. */
export const CAST_ENV_MAX_RUNNING = 10;
export const CAST_ENV_PATH = "/cli/cast/env-machine";

const refs = () => (internal as any).castCloudEnv;

/** An OpenSSH public key and nothing else: it is written into a boot script. */
export function validPublicKey(key: string): boolean {
  return /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]{40,1000}( [A-Za-z0-9@._-]{0,100})?$/.test(key.trim());
}

/** First boot: the laptop's key for the ubuntu login. Nothing else; the laptop provisions the rest over SSH. */
export function envMachineUserData(publicKey: string): string {
  if (!validPublicKey(publicKey)) throw new Error("unsafe public key");
  return `#!/bin/bash
set -euo pipefail
install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
printf '%s\\n' '${publicKey.trim()}' >> /home/ubuntu/.ssh/authorized_keys
chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
chmod 600 /home/ubuntu/.ssh/authorized_keys
`;
}

/** The fields the CLI reads from one instance, out of DescribeInstances XML. */
export function parseInstance(xml: string): { InstanceId: string; State: { Name: string }; PublicIpAddress?: string; InstanceType?: string } | null {
  const id = /<instanceId>(i-[0-9a-f]+)<\/instanceId>/.exec(xml)?.[1];
  if (!id) return null;
  const state = /<instanceState>\s*<code>\d+<\/code>\s*<name>([a-z-]+)<\/name>/.exec(xml)?.[1] ?? "pending";
  const ip = /<ipAddress>([0-9.]+)<\/ipAddress>/.exec(xml)?.[1];
  const type = /<instanceType>([a-z0-9.]+)<\/instanceType>/.exec(xml)?.[1];
  return { InstanceId: id, State: { Name: state }, ...(ip ? { PublicIpAddress: ip } : {}), ...(type ? { InstanceType: type } : {}) };
}

async function runningEnvMachines(): Promise<number> {
  const xml = await ec2({
    Action: "DescribeInstances",
    "Filter.1.Name": `tag:${CAST_ENV_TAG.Key}`, "Filter.1.Value.1": CAST_ENV_TAG.Value,
    "Filter.2.Name": "instance-state-name", "Filter.2.Value.1": "pending", "Filter.2.Value.2": "running",
  });
  return new Set(xml.match(/<instanceId>i-[0-9a-f]+<\/instanceId>/g) ?? []).size;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export const callerMachine = internalQuery({
  args: { api_token: v.string() },
  handler: async (ctx, args): Promise<{ user_id: Id<"users">; enabled: boolean; row: any } | null> => {
    const userId = (await verifyApiToken(ctx, args.api_token))?.userId;
    if (!userId) return null;
    const row = await ctx.db.query("cast_env_machines").withIndex("by_user", (q: any) => q.eq("user_id", userId)).first();
    return { user_id: userId, enabled: castMachinesEnabledFor(userId), row };
  },
});

export const recordMachine = internalMutation({
  args: { user_id: v.id("users"), ssh_public_key: v.string(), instance_id: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("cast_env_machines").withIndex("by_user", (q: any) => q.eq("user_id", args.user_id)).first();
    const now = Date.now();
    const fields = { ssh_public_key: args.ssh_public_key, ...(args.instance_id ? { instance_id: args.instance_id } : {}), error: args.error, updated_at: now };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("cast_env_machines", { user_id: args.user_id, region: CAST_MACHINE_REGION, created_at: now, ...fields });
  },
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

type Op = "request" | "describe" | "start" | "stop";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** describe-instances' shape, so the CLI's host code reads it unchanged. */
const described = (inst: ReturnType<typeof parseInstance>) => ({ Reservations: inst ? [{ Instances: [inst] }] : [] });

export const envMachineRoute = httpAction(async (ctx, request) => {
  let body: { api_token?: string; op?: Op; ssh_public_key?: string };
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  if (!body.api_token || !body.op || !["request", "describe", "start", "stop"].includes(body.op)) return json({ error: "need api_token and op (request, describe, start, stop)" }, 400);
  const me = await ctx.runQuery(refs().callerMachine, { api_token: body.api_token });
  if (!me) return json({ error: "not signed in: cast login" }, 401);
  if (!me.enabled) return json({ error: "cast cloud machines on codecast's account are not open to this account yet; pass --host <id> to use a machine of your own" }, 403);
  try {
    const id: string | undefined = me.row?.instance_id;
    if (body.op === "request") {
      if (id) {
        const inst = parseInstance(await ec2({ Action: "DescribeInstances", "InstanceId.1": id }));
        if (inst && inst.State.Name !== "terminated") return json({ instance_id: id, ...described(inst) });
      }
      const key = (body.ssh_public_key ?? "").trim();
      if (!validPublicKey(key)) return json({ error: "send the laptop's SSH public key (ssh_public_key)" }, 400);
      if ((await runningEnvMachines()) >= CAST_ENV_MAX_RUNNING) return json({ error: `all ${CAST_ENV_MAX_RUNNING} cast cloud machines are in use right now; try again in a few minutes` }, 503);
      const xml = await ec2({
        Action: "RunInstances", MinCount: "1", MaxCount: "1",
        "LaunchTemplate.LaunchTemplateName": CAST_ENV_LAUNCH_TEMPLATE,
        UserData: btoa(envMachineUserData(key)),
        // One machine per person: a retried request returns the same instance.
        ClientToken: `cast-env-${me.user_id}-${me.row?.created_at ?? "new"}`,
        "TagSpecification.1.ResourceType": "instance",
        "TagSpecification.1.Tag.1.Key": CAST_ENV_TAG.Key, "TagSpecification.1.Tag.1.Value": CAST_ENV_TAG.Value,
        "TagSpecification.1.Tag.2.Key": "codecast-user", "TagSpecification.1.Tag.2.Value": String(me.user_id),
        "TagSpecification.1.Tag.3.Key": "Name", "TagSpecification.1.Tag.3.Value": `cast-cloud-${String(me.user_id).slice(-8)}`,
      });
      const inst = parseInstance(xml);
      if (!inst) throw new Ec2Error("NoInstanceId");
      await ctx.runMutation(refs().recordMachine, { user_id: me.user_id, ssh_public_key: key, instance_id: inst.InstanceId });
      return json({ instance_id: inst.InstanceId, ...described(inst) });
    }
    if (!id) return json({ error: "no cast cloud machine yet: run cast cloud" }, 404);
    if (body.op === "start") {
      if ((await runningEnvMachines()) >= CAST_ENV_MAX_RUNNING) return json({ error: `all ${CAST_ENV_MAX_RUNNING} cast cloud machines are in use right now; try again in a few minutes` }, 503);
      await ec2({ Action: "StartInstances", "InstanceId.1": id });
    } else if (body.op === "stop") {
      await ec2({ Action: "StopInstances", "InstanceId.1": id });
    }
    const inst = parseInstance(await ec2({ Action: "DescribeInstances", "InstanceId.1": id }));
    return json({ instance_id: id, ...described(inst) });
  } catch (e) {
    const code = e instanceof Ec2Error ? e.code : "Failed";
    console.warn("cast_env_machine_failed", { op: body.op, code });
    if (code === "InvalidInstanceID.NotFound") return json({ instance_id: me.row?.instance_id, Reservations: [] });
    return json({ error: `AWS refused (${code})` }, 502);
  }
});
