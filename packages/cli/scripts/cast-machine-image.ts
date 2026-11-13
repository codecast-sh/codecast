#!/usr/bin/env bun
// Build the image every Cast machine is cloned from (convex/castMachines.ts).
// Runs the same provisioning scripts `cast hosts provision` runs, minus every
// step that carries a person's logins or config, then scrubs the box and
// captures it. A clone's first boot (castMachineUserData) signs its daemon in
// as its person and starts it.
//
//   bun packages/cli/scripts/cast-machine-image.ts <builder-ip> <ssh-key> [--profile p] [--region r]
//
// The builder is a fresh Ubuntu 24.04 amd64 instance tagged
// codecast-role=cast-image-builder; this script leaves it stopped after imaging.
import { execFileSync } from "node:child_process";
import { baseProvisionScript, daemonUnitScript, runScript } from "../src/browser/provisionLinux.js";
import { agentCliInstallScript } from "../src/browser/provisionAgents.js";
import { installHostRelease } from "../src/hosts/installRelease.js";
import type { RemoteHost } from "../src/remote/session-move.js";

const [address, keyPath] = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const profile = flag("--profile", "default");
const region = flag("--region", "us-west-2");
if (!address || !keyPath) throw new Error("usage: cast-machine-image.ts <builder-ip> <ssh-key>");

const host: RemoteHost = { address, user: "ubuntu", keyPath, remoteBaseDir: "/home/ubuntu/work", homeDir: "/home/ubuntu" };
const log = (m: string) => console.log(`  ${m}`);
const step = (name: string, script: string, ok: string, timeoutMs = 1_200_000) => {
  console.log(name);
  const out = runScript(host, script, timeoutMs);
  if (!out.includes(ok)) throw new Error(`${name} did not finish:\n${out.slice(-1500)}`);
};
const aws = (args: string[]) => JSON.parse(execFileSync("aws", [...args, "--profile", profile, "--region", region, "--output", "json"], { encoding: "utf8" }) || "null");

// 20 idle minutes, then the box powers itself off (a stop: only its disk bills).
step("base packages, display and idle watchdog", baseProvisionScript(20), "PROVISION-BASE-OK");
console.log("bun runtime");
runScript(host, "command -v ~/.bun/bin/bun >/dev/null 2>&1 || (sudo apt-get install -y -qq unzip >/dev/null 2>&1; curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1); sudo ln -sf ~/.bun/bin/bun /usr/local/bin/bun; ~/.bun/bin/bun --version", 300_000);
console.log("cast release");
installHostRelease(host, "linux", log);
step("agent CLIs (pi among them) and node", agentCliInstallScript({}), "AGENT-CLIS-OK");
// Writes the unit and the remote-device marker; with no login it cannot stay
// up, so its own is-active check is not the gate here.
console.log("daemon unit");
try { runScript(host, daemonUnitScript(), 120_000); } catch { /* no config yet */ }

console.log("scrub");
runScript(host, `set -euo pipefail
sudo systemctl disable --now codecast-daemon.service
pkill -u ubuntu -f "cast _daemon" || true
tmux kill-server 2>/dev/null || true
# Keep only the remote-device marker: no token, no machine key, no binding.
find /home/ubuntu/.codecast -mindepth 1 ! -name remote-device -exec rm -rf {} + 2>/dev/null || true
rm -rf /home/ubuntu/.pi /home/ubuntu/.bash_history /home/ubuntu/.cache/codecast
: > /home/ubuntu/.ssh/authorized_keys
sudo truncate -s 0 /etc/machine-id
sudo rm -f /var/lib/dbus/machine-id
sudo cloud-init clean --logs
echo SCRUB-OK`, 120_000);

const id = aws(["ec2", "describe-instances", "--filters", `Name=ip-address,Values=${address}`]).Reservations[0].Instances[0].InstanceId as string;
const name = `cast-user-machine-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
console.log(`imaging ${id} as ${name}`);
const image = aws(["ec2", "create-image", "--instance-id", id, "--name", name, "--description", "Cast user machine (codecast)",
  "--tag-specifications", JSON.stringify([{ ResourceType: "image", Tags: [{ Key: "codecast-role", Value: "cast-user-machine" }] }])]).ImageId;
// A 30 GiB encrypted image can take longer than one waiter's 10 minutes.
for (let i = 0; aws(["ec2", "describe-images", "--image-ids", image]).Images[0].State !== "available"; i++) {
  if (i > 120) throw new Error(`${image} is still not available after an hour`);
  execFileSync("sleep", ["30"]);
}
console.log(`image ${image} ready; stopping the builder`);
aws(["ec2", "stop-instances", "--instance-ids", id]);
console.log(image);
