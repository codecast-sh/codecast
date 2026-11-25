import { describe, expect, test } from "bun:test";
import { adoptHostForDevice, type AdoptDeps, type HostDeviceRow } from "./adopt.js";

const devices: HostDeviceRow[] = [
  { device_id: "laptop-2", label: "MacBook-Pro-2" },
  { device_id: "host-1", label: "Linux - host", cloud_host: { managed_by: "laptop-2", instance_id: "i-not-registered-here", provider: "aws", region: "us-west-2" } },
  { device_id: "host-2", label: "Mac host", cloud_host: { managed_by: "laptop-2", instance_id: "i-mac", provider: "scaleway-mac" } },
  { device_id: "host-3", label: "Silent host" },
];

function deps(calls: any[]): AdoptDeps {
  return {
    devices: async () => devices,
    key: () => ({ path: "/tmp/mine", pub: "ssh-ed25519 AAAA mine" }),
    up: (async (host: any, _p: any, _ph: any, opts: any) => { calls.push({ host, opts }); return { ...host, address: "1.2.3.4" }; }) as any,
    upsert: (h) => calls.push({ upsert: h }),
  };
}

describe("adoptHostForDevice", () => {
  test("registers a host another machine launched, letting this machine's key in", async () => {
    const calls: any[] = [];
    const host = await adoptHostForDevice("host-1", () => {}, deps(calls));
    expect(host).toMatchObject({ id: "i-not-registered-here", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/tmp/mine", deviceId: "host-1", address: "1.2.3.4" });
    expect(calls[0].opts).toEqual({ grantKey: "ssh-ed25519 AAAA mine" });
    expect(calls[1].upsert).toMatchObject({ id: "i-not-registered-here", deviceId: "host-1", keyPath: "/tmp/mine" });
  });

  test("names the launching machine when the provider cannot let another key in", async () => {
    await expect(adoptHostForDevice("host-2", () => {}, deps([]))).rejects.toThrow(/only MacBook-Pro-2, which launched it, holds its key/);
  });

  test("says so when the host never reported which machine it is", async () => {
    await expect(adoptHostForDevice("host-3", () => {}, deps([]))).rejects.toThrow(/has not reported which cloud machine/);
  });
});
