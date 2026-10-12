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
 * The public base images: a clean macOS with codecast's runtimes, a managed
 * `codecast` login signed into the desktop, and the computer helper's
 * Accessibility and Screen Recording grants, which macOS only takes from a
 * person at the screen. Built once by codecast and published from this
 * account, so nobody's first Mac needs that person. They carry no logins,
 * keys or device identity; each host sets its own password and takes its own
 * launch key on first provision (hosts/macLogin.ts).
 */
export const BASE_IMAGE_OWNER = "767398104971";
export const BASE_IMAGE_LOGIN = "codecast";

export function baseImageName(platform: string, now = new Date()): string {
  return `codecast-base-${platform}-${now.toISOString().slice(0, 10)}`;
}

/** Regions a base image is copied to, besides the one it is built in. */
export const BASE_IMAGE_REGIONS = ["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "eu-central-1"];

/**
 * What leaves a base Mac before it is imaged: everything that is one
 * machine's or one person's. SSH keys (the launch key comes back per instance
 * from ec2-macos-init, sshd regenerates host keys on first connection), the
 * desktop password file (each host sets its own), codecast's state except the
 * granted computer helper, and shell history. The autologin and the helper's
 * grants stay: they are the point of the image.
 */
export function macBaseScrubScript(login = BASE_IMAGE_LOGIN): string {
  return `set -euo pipefail
sudo -n true
for home in /Users/${login} /Users/ec2-user; do
  sudo rm -rf "$home/.ssh" "$home/.zsh_history" "$home/.bash_history" "$home/.zsh_sessions" "$home/.lesshst"
done
sudo find /Users/${login}/.codecast -mindepth 1 -maxdepth 1 ! -name computer -exec rm -rf {} +
sudo rm -f /etc/ssh/ssh_host_*
echo MAC-BASE-SCRUBBED`;
}

export function createBaseImageArgs(sourceId: string, platform: string, name: string): string[] {
  const tags = [{ Key: "codecast-base", Value: platform }, { Key: "Name", Value: name }];
  return ["ec2", "create-image", "--instance-id", sourceId, "--name", name,
    "--description", `codecast ${platform} base image: runtimes, a managed codecast desktop login, and cast computer's grants`,
    "--tag-specifications", JSON.stringify([{ ResourceType: "image", Tags: tags }, { ResourceType: "snapshot", Tags: tags }])];
}

/** Make this account's available base images public in every base region,
 *  copying the newest into regions that lack it. Returns one line per region. */
export function publishBaseImages(opts: { region: string; profile?: string }, platform: string): string[] {
  const own = (region: string) => (aws({ ...opts, region }, ["ec2", "describe-images", "--owners", "self", "--filters", `Name=name,Values=codecast-base-${platform}-*`]).Images ?? [])
    .sort((a: any, b: any) => (a.CreationDate < b.CreationDate ? 1 : -1));
  const source = own(opts.region).find((i: any) => i.State === "available");
  if (!source) return [`${opts.region}: no available ${platform} base image yet`];
  const lines: string[] = [];
  for (const region of [...new Set([opts.region, ...BASE_IMAGE_REGIONS])]) {
    const ro = { ...opts, region };
    const here = own(region).find((i: any) => i.Name === source.Name);
    if (!here) {
      const copy = aws(ro, ["ec2", "copy-image", "--source-region", opts.region, "--source-image-id", source.ImageId, "--name", source.Name,
        "--description", source.Description ?? "", "--copy-image-tags"]);
      lines.push(`${region}: copying ${source.Name} as ${copy.ImageId}; publish again once it is available`);
    } else if (here.State !== "available") {
      lines.push(`${region}: ${here.ImageId} is ${here.State}; publish again once it is available`);
    } else if (!here.Public) {
      // AWS blocks public images per region by default; lifting it is the account owner's call.
      const blocked = aws(ro, ["ec2", "get-image-block-public-access-state"]).ImageBlockPublicAccessState !== "unblocked";
      if (blocked) {
        lines.push(`${region}: public images are blocked in this account; aws ec2 disable-image-block-public-access --region ${region}, then publish again`);
        continue;
      }
      aws(ro, ["ec2", "modify-image-attribute", "--image-id", here.ImageId, "--launch-permission", JSON.stringify({ Add: [{ Group: "all" }] })]);
      lines.push(`${region}: ${here.ImageId} is public`);
    } else {
      lines.push(`${region}: ${here.ImageId} was already public`);
    }
  }
  return lines;
}

/** The newest public codecast base image for a platform in this region, or null. */
export function latestBaseImage(opts: { region: string; profile?: string }, platform: string): ImageRef | null {
  const out = aws(opts, ["ec2", "describe-images", "--owners", BASE_IMAGE_OWNER, "--filters", `Name=name,Values=codecast-base-${platform}-*`, "Name=state,Values=available"]);
  const newest = (out.Images ?? []).sort((a: any, b: any) => (a.CreationDate < b.CreationDate ? 1 : -1))[0];
  return newest ? { id: newest.ImageId, name: newest.Name, created: newest.CreationDate, platform } : null;
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
