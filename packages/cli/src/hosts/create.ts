import { execFileSync } from "../proc.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import { agentSpawnPath } from "../agentSpawnPath.js";
import { readHosts, upsertHost, type CloudHost } from "../browser/cloudHost.js";
import { aws, cloneResetUserData, IMAGE_TAG, listImages } from "./image.js";

export interface CreateHostOptions {
  name: string;
  key: string;
  keyName: string;
  region: string;
  profile?: string;
  image?: string;
  type?: string;
  subnet: string;
  securityGroup: string;
  dedicatedHost?: string;
  user?: string;
  disk?: string;
  dryRun?: boolean;
  provision?: boolean;
}

export function createHostPlan(platform: string, options: CreateHostOptions) {
  if (platform !== "linux" && platform !== "mac") throw new Error("Choose linux or mac");
  if (platform === "linux" && options.user && options.user !== "ubuntu" && options.provision !== false) throw new Error("Linux provisioning requires the ubuntu SSH user");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(options.name)) throw new Error("Name must be 1–63 letters, numbers, dots, dashes or underscores");
  if (!/^ami-[a-f0-9]+$/.test(options.image ?? "")) throw new Error("Provide an AWS AMI id with --image, or capture a host first with cast hosts image");
  if (!/^subnet-[a-f0-9]+$/.test(options.subnet) || !/^sg-[a-f0-9]+$/.test(options.securityGroup)) throw new Error("Provide the subnet and SSH security group ids");
  const type = options.type ?? (platform === "mac" ? "mac2.metal" : "t3.medium");
  if (!/^[a-z0-9-]+\.[a-z0-9]+$/.test(type)) throw new Error("Invalid instance type");
  if (/^mac\d|^mac-/.test(type) !== (platform === "mac")) throw new Error("Instance type must match Linux or Mac");
  if (platform === "mac" && !/^h-[a-f0-9]+$/.test(options.dedicatedHost ?? "")) throw new Error("Mac needs --dedicated-host <host-id>; allocate a matching AWS dedicated host first (24-hour minimum charge)");
  if (platform === "linux" && options.dedicatedHost) throw new Error("--dedicated-host is for Mac machines");
  const disk = Number(options.disk ?? (platform === "mac" ? "200" : "80"));
  if (!Number.isInteger(disk) || disk < 30 || disk > 16384) throw new Error("Disk size must be a whole number from 30 to 16384 GiB");
  const args = ["ec2", "run-instances", "--image-id", options.image!, "--instance-type", type,
    "--key-name", options.keyName, "--subnet-id", options.subnet, "--security-group-ids", options.securityGroup,
    "--associate-public-ip-address",
    "--count", "1", "--metadata-options", "HttpTokens=required,HttpEndpoint=enabled",
    "--instance-initiated-shutdown-behavior", "stop",
    "--tag-specifications", JSON.stringify([{ ResourceType: "instance", Tags: [{ Key: "Name", Value: options.name }, { Key: "managed-by", Value: "codecast" }] }]),
    ...(options.dedicatedHost ? ["--placement", `Tenancy=host,HostId=${options.dedicatedHost}`] : []),
  ];
  const clientToken = createHash("sha256").update(JSON.stringify([options.region, options.profile, args, disk])).digest("hex");
  const tagsIndex = args.indexOf("--tag-specifications") + 1;
  const tags = JSON.parse(args[tagsIndex]!);
  tags[0].Tags.push({ Key: "codecast-launch-token", Value: clientToken });
  args[tagsIndex] = JSON.stringify(tags);
  args.push("--client-token", clientToken);
  return { platform: platform === "mac" ? "darwin" as const : "linux" as const, type, disk, clientToken, args,
    billing: platform === "mac" ? "Dedicated Mac host charges continue while stopped, with a 24-hour minimum. Storage is separate." : "Compute is billed while running. Storage remains billed while stopped." };
}

export function registerHostCreateCommand(hosts: Command): void {
  hosts.command("create <platform>")
    .description("Launch an AWS Linux or Mac instance, register it, and set it up for sessions")
    .requiredOption("--name <name>", "Unique machine name; rerunning reuses its existing instance")
    .option("--image <ami>", "Ubuntu 24.04 x86_64 AMI, or macOS AMI matching the dedicated host (default: the newest image from cast hosts image)")
    .requiredOption("--key <path>", "Local SSH private key")
    .requiredOption("--key-name <name>", "Matching AWS key pair name")
    .requiredOption("--subnet <id>", "Subnet with public internet access")
    .requiredOption("--security-group <id>", "Security group allowing SSH from this machine")
    .option("--region <name>", "AWS region", "us-west-2")
    .option("--profile <name>", "AWS credentials profile")
    .option("--type <type>", "Instance type (Linux: t3.medium; Mac: mac2.metal)")
    .option("--dedicated-host <id>", "Existing dedicated host for Mac, matching the instance type and subnet zone")
    .option("--user <name>", "SSH user (Linux: ubuntu; Mac: ec2-user)")
    .option("--disk <gib>", "Encrypted root disk size (Linux: 80 GiB; Mac: 200 GiB)")
    .option("--dry-run", "Print the launch plan without creating or changing anything")
    .option("--no-provision", "Register the instance without installing Codecast")
    .action(async (platform: string, options: CreateHostOptions) => {
      if (!options.image) {
        const latest = listImages(options, platform === "mac" ? "darwin" : "linux")[0];
        if (!latest) throw new Error("No codecast image yet: pass --image <ami>, or capture a prepared host with cast hosts image <id>");
        options.image = latest.id;
        console.log(`Launching from ${latest.name} (${latest.id}), captured ${latest.created}${latest.source ? ` from ${latest.source}` : ""}`);
      }
      const plan = createHostPlan(platform, options);
      const keyPath = path.resolve(options.key.replace(/^~(?=\/)/, os.homedir()));
      if (options.dryRun) {
        console.log(JSON.stringify({ ...plan, region: options.region, profile: options.profile, keyPath }, null, 2));
        return;
      }
      if (!fs.statSync(keyPath).isFile()) throw new Error(`SSH key is not a file: ${keyPath}`);
      const existing = aws(options, ["ec2", "describe-instances", "--filters", `Name=tag:Name,Values=${options.name}`, "Name=tag:managed-by,Values=codecast", "Name=instance-state-name,Values=pending,running,stopping,stopped"])
        .Reservations?.flatMap((reservation: any) => reservation.Instances ?? []) ?? [];
      if (existing.length > 1) throw new Error(`More than one machine is named ${options.name}; use cast hosts add with its instance id`);
      let instance = existing[0];
      if (instance && instance.Tags?.find((tag: { Key: string }) => tag.Key === "codecast-launch-token")?.Value !== plan.clientToken) throw new Error(`Existing machine ${options.name} has different or unverified launch settings; choose another name or register its instance id`);
      if (!instance) {
        const image = aws(options, ["ec2", "describe-images", "--image-ids", options.image]).Images?.[0];
        if (!image?.RootDeviceName) throw new Error("The AMI has no root device");
        const minimumDisk = image.BlockDeviceMappings?.find((mapping: { DeviceName: string }) => mapping.DeviceName === image.RootDeviceName)?.Ebs?.VolumeSize;
        if (typeof minimumDisk === "number" && plan.disk < minimumDisk) throw new Error(`This AMI needs at least ${minimumDisk} GiB; increase --disk before launching`);
        if (platform === "linux" && image.Architecture !== "x86_64") throw new Error("Linux display provisioning currently needs an x86_64 Ubuntu image");
        console.log(plan.billing);
        // A codecast image is another host's disk: the clone makes itself its own machine before its daemon starts.
        const clone = image.Tags?.some((t: { Key: string; Value: string }) => t.Key === IMAGE_TAG.Key && t.Value === IMAGE_TAG.Value);
        const userData = clone ? ["--user-data", cloneResetUserData(options.user ?? (platform === "mac" ? "ec2-user" : "ubuntu"))] : [];
        instance = aws(options, [...plan.args, ...userData, "--block-device-mappings", JSON.stringify([{ DeviceName: image.RootDeviceName, Ebs: { VolumeSize: plan.disk, VolumeType: "gp3", Encrypted: true, DeleteOnTermination: true } }])]).Instances?.[0];
        if (!instance?.InstanceId) throw new Error("AWS did not return an instance id; inspect the AWS console before retrying");
      }
      const host: CloudHost = { ...readHosts().find((entry) => entry.id === instance.InstanceId), id: instance.InstanceId, provider: "aws", region: options.region,
        profile: options.profile, platform: plan.platform, keyPath, user: options.user ?? (platform === "mac" ? "ec2-user" : "ubuntu"), address: instance.PublicIpAddress };
      upsertHost(host);
      console.log(`Registered ${host.id}. Resume setup with: cast hosts provision ${host.id}`);
      if (options.provision !== false) await hosts.parseAsync(["provision", host.id], { from: "user" });
    });
}
