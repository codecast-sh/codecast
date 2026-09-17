import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureUp, patchHost, readHosts, registryLockPath, writeHosts, type CloudHost } from "./cloudHost";

let dir: string, prev: string | undefined;
const base: CloudHost = { id: "i-1", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/k", address: "1.1.1.1", forwardAgent: true, idleStopMinutes: 20 };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-hosts-"));
  prev = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  writeHosts([base, { ...base, id: "i-2", address: "2.2.2.2" }]);
});

afterEach(() => {
  if (prev === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("patchHost — field-level registry writes under a lock", () => {
  test("merges only the named fields and leaves the other entry alone; an explicit undefined clears a field", () => {
    const merged = patchHost("i-1", { address: "9.9.9.9", gitAccess: { origin: "o", read: true, write: false, checkedAt: 1 } });
    expect(merged).toEqual({ ...base, address: "9.9.9.9", gitAccess: { origin: "o", read: true, write: false, checkedAt: 1 } });
    const hosts = readHosts();
    expect(hosts.find((h) => h.id === "i-1")).toEqual(merged);
    expect(hosts.find((h) => h.id === "i-2")).toEqual({ ...base, id: "i-2", address: "2.2.2.2" });
    expect(patchHost("i-1", { gitAccess: undefined })!.gitAccess).toBeUndefined();
    expect("gitAccess" in readHosts().find((h) => h.id === "i-1")!).toBe(false);
    expect(fs.existsSync(registryLockPath())).toBe(false);
  });

  test("an unknown id returns undefined and writes nothing", () => {
    const before = fs.readFileSync(path.join(dir, "browser", "hosts.json"), "utf-8");
    expect(patchHost("i-nope", { address: "x" })).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, "browser", "hosts.json"), "utf-8")).toBe(before);
    expect(fs.existsSync(registryLockPath())).toBe(false);
  });

  test("a stale lock (older than 5s) is broken; a fresh one is waited for, then the write goes through", () => {
    const lock = registryLockPath();
    fs.writeFileSync(lock, "999999");
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lock, old, old);
    expect(patchHost("i-1", { forwardAgent: false })!.forwardAgent).toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
    // A fresh lock that is never released: patchHost retries, then gives up loudly rather than clobbering.
    fs.writeFileSync(lock, "999999");
    expect(() => patchHost("i-1", { address: "x" })).toThrow(/registry is locked/);
    expect(readHosts().find((h) => h.id === "i-1")!.address).toBe("1.1.1.1");
    fs.unlinkSync(lock);
  });

  test("two processes patching different fields at once both survive (ensureUp's address write vs forward-agent --off)", () => {
    // Each child writes 30 patches of its own field with the other field untouched.
    const script = `
      import { patchHost } from ${JSON.stringify(path.resolve(import.meta.dir, "cloudHost.ts"))};
      const [field, value] = process.argv.slice(2);
      for (let i = 0; i < 30; i++) patchHost("i-1", { [field]: field === "forwardAgent" ? value === "true" : value + i });
    `;
    const file = path.join(dir, "worker.ts");
    fs.writeFileSync(file, script);
    const a = Bun.spawn([process.execPath, file, "address", "10.0.0."], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const r = spawnSync(process.execPath, [file, "forwardAgent", "false"], { env: process.env, encoding: "utf-8" });
    expect(r.status).toBe(0);
    const aStatus = a.exited;
    return aStatus.then((code) => {
      expect(code).toBe(0);
      const h = readHosts().find((x) => x.id === "i-1")!;
      expect(h.address).toBe("10.0.0.29");
      expect(h.forwardAgent).toBe(false);
      expect(h.idleStopMinutes).toBe(20);
      expect(fs.existsSync(registryLockPath())).toBe(false);
    });
  });
});

describe("ensureUp — the address write is a field-level patch", () => {
  let savedHome: string | undefined, savedPath: string | undefined;
  beforeEach(() => {
    savedHome = process.env.HOME;
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
  });

  test("a forwardAgent cleared while ensureUp held a stale host object is not resurrected by its address write", async () => {
    // aws() resolves its PATH from agentSpawnPath(): ~/.local/bin first, so a
    // fake aws under a redirected HOME wins over anything on the real PATH.
    const home = path.join(dir, "home");
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, "aws"), `#!/bin/sh
case "$*" in
  *describe-instances*) echo '{"Reservations":[{"Instances":[{"State":{"Name":"running"},"PublicIpAddress":"5.5.5.5"}]}]}';;
  *) echo '{}';;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(localBin, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.HOME = home;
    process.env.PATH = `${localBin}:${process.env.PATH}`;
    // The object ensureUp was handed still says forwardAgent: true; `cast hosts forward-agent --off` ran meanwhile.
    patchHost("i-1", { forwardAgent: false, gitAccess: { origin: "o", read: true, write: true, checkedAt: 7 } });
    const up = await ensureUp({ ...base, address: "1.1.1.1", forwardAgent: true });
    expect(up.address).toBe("5.5.5.5");
    const entry = readHosts().find((h) => h.id === "i-1")!;
    expect(entry.address).toBe("5.5.5.5");
    expect(entry.forwardAgent).toBe(false);
    expect(entry.gitAccess).toEqual({ origin: "o", read: true, write: true, checkedAt: 7 });
    expect(entry.idleStopMinutes).toBe(20);
    expect(readHosts().find((h) => h.id === "i-2")!.address).toBe("2.2.2.2");
    expect(fs.existsSync(registryLockPath())).toBe(false);
  });
});
