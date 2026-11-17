import type { CloudHost } from "../../browser/cloudHost.js";
import { HostGone } from "./ec2Start.js";
import { namespaceProvider } from "./namespace.js";
import type { HostBoot, HostBootHooks } from "./types.js";

export async function bootNamespace(host: CloudHost, { onProgress, onPhase }: HostBootHooks): Promise<HostBoot> {
  const { state, address } = namespaceProvider.state(host);
  if (state === "missing") throw new HostGone(host);
  if (state === "stopped") {
    onProgress(`starting ${address}`);
    onPhase("booting");
  }
  return { address: address ?? host.address ?? host.id, wasRunning: state === "running" };
}
