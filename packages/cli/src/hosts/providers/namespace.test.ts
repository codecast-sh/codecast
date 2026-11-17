import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CloudHost } from "../../browser/cloudHost";
import { estimateHostCost } from "../cli";
import { FAKE_BOX, installFakeNamespace } from "../../test-helpers/fakeNamespace";
import { hostProvider, hostSleeps, isMacHost } from "./registry";
import { namespaceProvider, NamespaceCliFailed } from "./namespace";
import { bootNamespace } from "./namespaceStart";

const host: CloudHost = {
  id: "box123", provider: "namespace", region: "iad", platform: "linux", user: "devbox", keyPath: "/k/cast-box.key",
  address: "cast-box", proxyCommand: "/b/devbox ssh-proxy cast-box",
};
const STARTED = "2026-11-17T10:00:00Z";

let root: string, fake: ReturnType<typeof installFakeNamespace>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cast-ns-"));
  fake = installFakeNamespace(root);
  for (const k of ["HOME", "PATH", "FAKE_NS"]) saved[k] = process.env[k];
  process.env.HOME = fake.home;
  process.env.FAKE_NS = fake.state;
  fake.set("devbox-list", JSON.stringify([FAKE_BOX]));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("namespace provider state", () => {
  test("running: the nsc instance names its start, the address is the box name", () => {
    fake.set("nsc-list", JSON.stringify([{ created_at: STARTED, shape: {}, labels: {} }]));
    expect(namespaceProvider.state(host)).toEqual({ state: "running", address: "cast-box", startedAt: Date.parse(STARTED) });
    expect(fake.calls()).toEqual([["devbox", "list", "-o", "json"], ["nsc", "list", "--label", "devbox.id=box123", "-o", "json"]]);
  });

  test("stopped: nsc prints the literal null", () => {
    expect(namespaceProvider.state(host)).toEqual({ state: "stopped", address: "cast-box" });
  });

  test("missing: a box absent from devbox list, without asking nsc", () => {
    fake.set("devbox-list", "[]");
    expect(namespaceProvider.state(host)).toEqual({ state: "missing" });
    expect(fake.calls().some((c) => c[0] === "nsc")).toBe(false);
  });

  test("no boxes at all reads as missing whether devbox prints nothing, null or []", () => {
    for (const out of ["", "null", "[]"]) {
      fake.set("devbox-list", out);
      expect(namespaceProvider.state(host)).toEqual({ state: "missing" });
    }
  });

  test("a failing nsc throws and is never read as stopped", () => {
    fake.set("nsc-fail");
    expect(() => namespaceProvider.state(host)).toThrow(NamespaceCliFailed);
    expect(() => namespaceProvider.state(host)).toThrow("not logged in");
  });

  test("a failing or unparsable devbox list throws and is never read as no boxes", () => {
    fake.set("devbox-fail");
    expect(() => namespaceProvider.state(host)).toThrow("boom");
    fs.rmSync(path.join(fake.state, "devbox-fail"));
    fake.set("devbox-list", "not json");
    expect(() => namespaceProvider.state(host)).toThrow("not JSON");
  });

  test("unparsable nsc output throws", () => {
    fake.set("nsc-list", "{broken");
    expect(() => namespaceProvider.state(host)).toThrow("not JSON");
  });

  test("a missing devbox binary says it is not installed", () => {
    fs.rmSync(path.join(fake.bin, "devbox"));
    process.env.PATH = path.join(root, "empty");
    expect(() => namespaceProvider.state(host)).toThrow("the devbox CLI is not installed");
  });
});

describe("the async state read", () => {
  test("is the same instance the sync read finds, or null when stopped", async () => {
    fake.set("nsc-list", JSON.stringify([{ created_at: STARTED }]));
    expect(await namespaceProvider.describeAsync!(host)).toEqual({ created_at: STARTED });
    fs.rmSync(path.join(fake.state, "nsc-list"));
    expect(await namespaceProvider.describeAsync!(host)).toBeNull();
  });

  test("a failing or unparsable nsc rejects, never reads as stopped", async () => {
    fake.set("nsc-fail");
    await expect(namespaceProvider.describeAsync!(host)).rejects.toThrow();
    fs.rmSync(path.join(fake.state, "nsc-fail"));
    fake.set("nsc-list", "{broken");
    await expect(namespaceProvider.describeAsync!(host)).rejects.toThrow("not JSON");
  });
});

describe("forgetting a Devbox host", () => {
  const key = () => path.join(fake.home, ".namespace", "ssh", "cast-box.devbox.namespace.key");
  const ssh = () => key().replace(/\.key$/, ".ssh");
  beforeEach(() => {
    fs.mkdirSync(path.dirname(key()), { recursive: true });
    fs.writeFileSync(key(), "");
    fs.writeFileSync(ssh(), "");
  });

  test("removes both generated files and says how to restore them, in one line", () => {
    const line = namespaceProvider.forget!(host);
    expect(line).toContain("devbox configure-ssh cast-box");
    expect(line).not.toContain("\n");
    expect(fs.existsSync(key()) || fs.existsSync(ssh())).toBe(false);
    expect(fake.calls()).toEqual([]);
  });
});

describe("namespace provider inspect, stop and capabilities", () => {
  test("inspect carries the name, linux and the shape", () => {
    fake.set("nsc-list", JSON.stringify([{ created_at: STARTED }]));
    expect(namespaceProvider.inspect(host)).toEqual({
      state: "running", address: "cast-box", startedAt: Date.parse(STARTED), name: "cast-box", platform: "linux", instanceType: "2 vCPU / 4 GB",
    });
    fake.set("devbox-list", "[]");
    expect(namespaceProvider.inspect(host)).toEqual({ state: "missing" });
  });

  test("stop forces the box by name", () => {
    namespaceProvider.stop(host);
    expect(fake.calls()).toEqual([["devbox", "stop", "--force", "cast-box"]]);
    expect(() => namespaceProvider.stop({ ...host, address: undefined })).toThrow("no box name");
  });

  test("the registry knows it: sleeps, not a Mac, cannot image, clone or resize", () => {
    expect(hostProvider(host)).toBe(namespaceProvider);
    expect(hostSleeps(host)).toBe(true);
    expect(isMacHost(host)).toBe(false);
    expect([namespaceProvider.images, namespaceProvider.clones, namespaceProvider.resizes, namespaceProvider.macOnly]).toEqual([false, false, false, false]);
  });

  test("cost is unknown for a Devbox and still priced for aws", () => {
    expect(estimateHostCost({ host, instanceType: "2 vCPU / 4 GB", state: "running", volumeGiB: undefined }).line).toBe("awake: rate unknown for 2 vCPU / 4 GB, disk size unknown");
    const aws: CloudHost = { ...host, id: "i-1", provider: "aws" };
    expect(estimateHostCost({ host: aws, instanceType: "t3.medium", state: "running" }).hourlyUsd).toBe(0.0416);
  });
});

describe("starting a Devbox", () => {
  const hooks = () => {
    const seen: string[] = [];
    return { seen, onProgress: (m: string) => seen.push(`progress:${m}`), onPhase: (p: string) => seen.push(`phase:${p}`) } as const;
  };

  test("a stopped box reports booting and starts nothing itself: the ssh wait starts it", async () => {
    const h = hooks();
    expect(await bootNamespace(host, h as any)).toEqual({ address: "cast-box", wasRunning: false });
    expect(h.seen).toEqual(["progress:starting cast-box", "phase:booting"]);
    expect(fake.calls().filter((c) => c[0] === "devbox").every((c) => c[1] === "list")).toBe(true);
  });

  test("a running box is already up", async () => {
    fake.set("nsc-list", JSON.stringify([{ created_at: STARTED }]));
    const h = hooks();
    expect(await bootNamespace(host, h as any)).toEqual({ address: "cast-box", wasRunning: true });
    expect(h.seen).toEqual([]);
  });

  test("a deleted box is gone, with the way to forget it", async () => {
    fake.set("devbox-list", "[]");
    await expect(bootNamespace(host, hooks() as any)).rejects.toThrow("cast hosts rm box123");
  });
});
