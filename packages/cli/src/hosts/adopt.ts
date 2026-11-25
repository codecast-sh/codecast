/**
 * Register on this machine a cloud host another of the person's machines
 * launched. The host registry and the launch key live only on the machine that
 * ran `cast hosts create` (or autoscale), so without this a move to or from
 * the host, run anywhere else, had no way in.
 *
 * The facts come from the host's device row (cloud_host: instance id, region,
 * provider, reported by the managing machine). Access comes from this
 * machine's own cloud key, let in once through the provider (EC2 Instance
 * Connect, under the same AWS account) and then written to authorized_keys,
 * so later connections need nothing special.
 */

import { ensureUp, readHosts, upsertHost, type CloudHost } from "../browser/cloudHost.js";
import { ensureManagedKey, managedKeyPath } from "../cloud/env/managedHost.js";
import { hostProvider } from "./providers/registry.js";

export interface HostDeviceRow {
  device_id: string;
  label?: string;
  cloud_host?: { managed_by: string; instance_id: string; provider: CloudHost["provider"]; region?: string } | null;
}

export interface AdoptDeps {
  devices: () => Promise<HostDeviceRow[]>;
  key: () => { path: string; pub: string };
  up: typeof ensureUp;
  upsert: (h: CloudHost) => void;
}

async function serverDevices(): Promise<HostDeviceRow[]> {
  const { convexClient } = await import("../remote/convexClient.js");
  const cc = await convexClient({ timeoutMs: 10_000 });
  return cc.client.query(cc.api.devices.listDevices, { api_token: cc.token });
}

const defaultDeps: AdoptDeps = {
  devices: serverDevices,
  key: () => ({ path: managedKeyPath(), pub: ensureManagedKey() }),
  up: ensureUp,
  upsert: upsertHost,
};

/** The host behind `deviceId`, registered here and awake, or an error saying why it cannot be. */
export async function adoptHostForDevice(deviceId: string, log: (line: string) => void, deps: AdoptDeps = defaultDeps): Promise<CloudHost> {
  const devices = await deps.devices();
  const row = devices.find((d) => d.device_id === deviceId);
  const report = row?.cloud_host;
  const name = row?.label ?? deviceId.slice(0, 8);
  if (!report) throw new Error(`${name} has not reported which cloud machine it is (its managing machine reports that while it is online)`);
  const existing = readHosts().find((h) => h.id === report.instance_id);
  if (existing) return existing;
  const manager = devices.find((d) => d.device_id === report.managed_by)?.label ?? report.managed_by.slice(0, 8);
  const host: CloudHost = {
    id: report.instance_id, provider: report.provider, region: report.region ?? "us-west-2",
    platform: "linux", user: "ubuntu", keyPath: "", deviceId,
  };
  if (!hostProvider(host).grantKey) {
    throw new Error(`${name} is a ${report.provider} machine; only ${manager}, which launched it, holds its key`);
  }
  const key = deps.key();
  host.keyPath = key.path;
  log(`  ${host.id}: launched by ${manager}; letting this machine's key in`);
  const up = await deps.up(host, (m) => log(`  ${host.id}: ${m}`), () => {}, { grantKey: key.pub });
  deps.upsert({ ...up, deviceId });
  return { ...up, deviceId };
}
