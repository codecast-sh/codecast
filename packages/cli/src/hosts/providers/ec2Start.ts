import type { CloudHost } from "../../browser/cloudHost.js";
import { aws, ec2State } from "./aws.js";
import type { HostBoot, HostBootHooks } from "./types.js";

export class HostGone extends Error {
  constructor(host: CloudHost) {
    super(
      `host ${host.id} no longer exists (terminated, or deleted outside codecast).\n` +
        `  Remove it with: cast hosts rm ${host.id}`,
    );
    this.name = "HostGone";
  }
}

/**
 * Make sure the host's security group admits SSH from wherever we are.
 *
 * The group used to pin port 22 to the laptop's /32. That failed twice in one
 * afternoon, and the second failure is the instructive one: on a mobile
 * network the address a web probe reports (checkip: 172.56.161.83) was NOT
 * the address the SSH flow left from (sshd saw 172.56.35.173) — carrier NAT
 * hands out egress addresses per flow, so no probe can learn the right /32
 * and the rule cannot be made to converge. Both times the symptom was an SSH
 * timeout that read as "the host is broken".
 *
 * So the rule is key-only SSH from anywhere — the ordinary EC2 posture. The
 * key is the boundary (the Ubuntu image ships with password auth off), and
 * nothing else on the box listens publicly: CDP and the screen stream bind to
 * loopback and are reached through that same SSH. Manual entries in the group
 * are left alone; only our own tagged rules are managed.
 */
const AUTO_RULE_TAG = "codecast-auto";
const ANYWHERE = "0.0.0.0/0";

export function healSecurityGroup(host: CloudHost, onProgress: (m: string) => void, inst: any): void {
  if (host.platform === "darwin") return;
  try {
    const groupId = inst?.SecurityGroups?.[0]?.GroupId;
    if (!groupId) return;

    const sg = aws(["ec2", "describe-security-groups", "--group-ids", groupId], host.region, host.profile);
    const sshRules = (sg?.SecurityGroups?.[0]?.IpPermissions ?? []).filter(
      (p: any) => p.IpProtocol === "tcp" && p.FromPort === 22 && p.ToPort === 22,
    );
    const ranges: Array<{ CidrIp: string; Description?: string }> = sshRules.flatMap((p: any) => p.IpRanges ?? []);

    if (!ranges.some((x) => x.CidrIp === ANYWHERE)) {
      onProgress("allowing key-only SSH from anywhere (a pinned address cannot follow a laptop across networks)");
      aws(
        ["ec2", "authorize-security-group-ingress", "--group-id", groupId, "--ip-permissions",
         JSON.stringify([{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: ANYWHERE, Description: AUTO_RULE_TAG }] }])],
        host.region, host.profile,
      );
    }
    // Retire the per-network /32s this code added before it learned better.
    const stale = ranges.filter((x) => x.Description === AUTO_RULE_TAG && x.CidrIp !== ANYWHERE);
    if (stale.length) {
      aws(
        ["ec2", "revoke-security-group-ingress", "--group-id", groupId, "--ip-permissions",
         JSON.stringify([{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: stale.map((x) => ({ CidrIp: x.CidrIp })) }])],
        host.region, host.profile,
      );
    }
  } catch {
    // Healing is best-effort: if the rule is already right, SSH works anyway,
    // and if AWS says no we will find out from the SSH wait loop's error.
  }
}

export async function bootEc2(
  host: CloudHost,
  ops: { describe: () => any; start: () => void; healSecurityGroup: boolean },
  { onProgress, onPhase }: HostBootHooks,
): Promise<HostBoot> {
  let inst = ops.describe();
  let { state, address } = ec2State(inst);
  if (state === "missing") throw new HostGone(host);
  const wasRunning = state === "running";

  if (state === "stopped") {
    onProgress(`starting ${host.id}`);
    ops.start();
    state = "pending";
    onPhase("booting");
  }

  const bootMinutes = host.platform === "darwin" ? 25 : 3;
  const deadline = Date.now() + bootMinutes * 60_000;
  while (state !== "running") {
    if (Date.now() > deadline) throw new Error(`${host.id} did not reach "running" within ${bootMinutes} minutes`);
    await new Promise((r) => setTimeout(r, 4000));
    inst = ops.describe();
    ({ state, address } = ec2State(inst));
    if (state === "missing") throw new HostGone(host);
  }

  if (!address) throw new Error(`${host.id} is running but has no public address`);
  if (!wasRunning) onPhase("running");

  if (ops.healSecurityGroup) healSecurityGroup(host, onProgress, inst);
  return { address, wasRunning };
}
