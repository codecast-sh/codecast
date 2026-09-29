/**
 * Saved machine images: a prepared host (packages, services, tools, the repo
 * checkout, the mirrored home) captured as an AMI, so the next host starts
 * from it instead of rediscovering everything, and a drifted host can be
 * replaced by a fresh one from the same point.
 *
 * `cast hosts image <id>` captures a running or stopped host (no reboot).
 * `cast hosts create` then launches from the newest codecast image for the
 * platform when `--image` is not given, with a one-time early-boot step
 * (cloud-init bootcmd, per instance, before the daemon's network-online
 * ordering lets it start) that makes the clone its own machine: a new
 * /etc/machine-id, so its device id is a clone id (remote/device.ts
 * resolveDeviceIdentity) and never the source host's; the source's codecast
 * token dropped, so it never acts as that device; the source's session
 * worktrees and their private caches cleared. Provisioning then gives it a
 * token of its own, and the mirror, logins and host setup find it in step.
 */

import { execFileSync } from "../proc.js";
import { agentSpawnPath } from "../agentSpawnPath.js";

export const IMAGE_TAG = { Key: "managed-by", Value: "codecast" };

export interface ImageRef { id: string; name: string; created: string; platform: string; source?: string }

export function aws(opts: { region: string; profile?: string }, args: string[]): any {
  const output = execFileSync("aws", [...args, "--region", opts.region, ...(opts.profile ? ["--profile", opts.profile] : []), "--output", "json"], {
    encoding: "utf8", timeout: 120_000, env: { ...process.env, PATH: agentSpawnPath(), AWS_PAGER: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  return output.trim() ? JSON.parse(output) : {};
}

export function imageName(platform: string, sourceId: string, now = new Date()): string {
  return `codecast-${platform}-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${sourceId.slice(-6)}`;
}

export function createImageArgs(sourceId: string, platform: string, name: string): string[] {
  const tags = [IMAGE_TAG, { Key: "codecast-platform", Value: platform }, { Key: "codecast-source", Value: sourceId }, { Key: "Name", Value: name }];
  return ["ec2", "create-image", "--instance-id", sourceId, "--name", name, "--no-reboot",
    "--description", `codecast ${platform} host image from ${sourceId}`,
    "--tag-specifications", JSON.stringify([{ ResourceType: "image", Tags: tags }, { ResourceType: "snapshot", Tags: tags }])];
}

/** The account's codecast images for a platform, newest first. */
export function listImages(opts: { region: string; profile?: string }, platform: string): ImageRef[] {
  const out = aws(opts, ["ec2", "describe-images", "--owners", "self", "--filters", `Name=tag:managed-by,Values=codecast`, `Name=tag:codecast-platform,Values=${platform}`, "Name=state,Values=available"]);
  return (out.Images ?? []).map((i: any) => ({
    id: i.ImageId, name: i.Name, created: i.CreationDate, platform,
    source: i.Tags?.find((t: { Key: string }) => t.Key === "codecast-source")?.Value,
  })).sort((a: ImageRef, b: ImageRef) => (a.created < b.created ? 1 : -1));
}

/**
 * cloud-init user data for a host launched from a codecast image: once per
 * instance, early in boot, before the codecast daemon starts.
 */
export function cloneResetUserData(user = "ubuntu"): string {
  const home = `/home/${user}`;
  const script = [
    "systemctl stop codecast-daemon 2>/dev/null || true",
    "rm -f /etc/machine-id /var/lib/dbus/machine-id",
    "systemd-machine-id-setup",
    `rm -f ${home}/.codecast/config.json ${home}/.codecast/.device_binding.json ${home}/.codecast/host-active`,
    `for r in ${home}/work/*/; do rm -rf "$r.codecast/worktrees" "$r.codecast/workspaces"; su - ${user} -c "git -C '$r' worktree prune" 2>/dev/null || true; done`,
  ].join("; ");
  return `#cloud-config
bootcmd:
  - [cloud-init-per, instance, codecast-clone-reset, sh, -c, ${JSON.stringify(script)}]
`;
}

/** Deregister a codecast image and delete its snapshots (refuses an image that is not codecast's). */
export function deleteImage(opts: { region: string; profile?: string }, imageId: string): void {
  const img = aws(opts, ["ec2", "describe-images", "--image-ids", imageId]).Images?.[0];
  if (!img) throw new Error(`no image ${imageId}`);
  if (!img.Tags?.some((t: { Key: string; Value: string }) => t.Key === IMAGE_TAG.Key && t.Value === IMAGE_TAG.Value)) throw new Error(`${imageId} is not a codecast image`);
  aws(opts, ["ec2", "deregister-image", "--image-id", imageId]);
  for (const m of img.BlockDeviceMappings ?? []) if (m.Ebs?.SnapshotId) aws(opts, ["ec2", "delete-snapshot", "--snapshot-id", m.Ebs.SnapshotId]);
}
