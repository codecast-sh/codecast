import { describe, expect, it } from "bun:test";
import { Updater, type UpdaterFs } from "./updater";
import { sha256Hex } from "./checksum";

// An in memory file system and fetch so the whole update path runs under test.
function memFs(initial: Record<string, Uint8Array | string> = {}) {
  const files = new Map<string, Uint8Array>();
  const links = new Map<string, string>();
  const dirs = new Set<string>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  for (const [k, v] of Object.entries(initial)) files.set(k, typeof v === "string" ? enc.encode(v) : v);
  const fs: UpdaterFs = {
    existsSync: (p) => files.has(p) || dirs.has(p) || links.has(p),
    readFileSync: (p) => {
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return f;
    },
    readTextSync: (p) => dec.decode(fs.readFileSync(p)),
    writeTextSync: (p, t) => void files.set(p, enc.encode(t)),
    mkdirSync: (p) => void dirs.add(p),
    unlinkSync: (p) => {
      if (links.delete(p)) return;
      if (!files.delete(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    renameSync: (a, b) => {
      const f = files.get(a);
      if (!f) throw new Error(`rename: missing ${a}`);
      files.delete(a);
      files.set(b, f);
    },
    chmodSync: () => {},
    readlinkSync: (p) => {
      const t = links.get(p);
      if (!t) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return t;
    },
    symlinkSync: (target, link) => void links.set(link, target),
  };
  return { fs, files, links };
}

function fakeFetch(routes: Record<string, { status?: number; body: unknown | Uint8Array }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const r = routes[url];
    if (!r) return new Response("nf", { status: 404 });
    const status = r.status ?? 200;
    if (r.body instanceof Uint8Array) return new Response(r.body, { status });
    return new Response(JSON.stringify(r.body), { status });
  }) as typeof fetch;
}

const BASE = "https://dl.example.com";
const newBinary = new TextEncoder().encode("NEW BINARY BYTES");

async function setup(opts: { current?: string; latest?: string; corrupt?: boolean; min?: string | null; now?: () => number } = {}) {
  const sha = await sha256Hex(newBinary);
  const { fs, files, links } = memFs({ "/opt/acme/acme": "OLD" });
  let downloaded = 0;
  const fetch = fakeFetch({
    [`${BASE}/latest.json`]: {
      body: {
        version: opts.latest ?? "1.1.0",
        released: "2026-01-01T00:00:00Z",
        binaries: { "darwin-arm64": { url: `${BASE}/acme-darwin-arm64`, sha256: opts.corrupt ? "00".repeat(32) : sha } },
      },
    },
    [`${BASE}/latest-beta.json`]: { body: { version: "1.2.0-beta", released: "", binaries: {} } },
  });
  const updater = new Updater({
    productName: "Acme",
    binaryName: "acme",
    aliasName: "ac",
    currentVersion: opts.current ?? "1.0.0",
    releaseBaseUrl: BASE,
    channels: [{ name: "stable", manifestPath: "latest.json" }, { name: "beta", manifestPath: "latest-beta.json" }],
    stateDir: "/home/u/.acme",
    minVersion: opts.min === undefined ? undefined : async () => opts.min ?? null,
    fetch,
    fs,
    download: async (_url, dest) => {
      downloaded++;
      files.set(dest, newBinary);
    },
    execPath: "/opt/acme/acme",
    platform: "darwin",
    arch: "arm64",
    now: opts.now ?? (() => 1_000_000),
    log: () => {},
  });
  return { updater, files, links, downloads: () => downloaded };
}

describe("Updater", () => {
  it("reports a newer version and caches it in state", async () => {
    const { updater } = await setup();
    expect(await updater.checkForUpdates()).toBe("1.1.0");
    expect(updater.readState().availableVersion).toBe("1.1.0");
    expect(updater.readState().lastCheck).toBeDefined();
  });

  it("returns null when current is latest and clears the cached version", async () => {
    const { updater } = await setup({ current: "1.1.0" });
    expect(await updater.checkForUpdates()).toBeNull();
    expect(updater.readState().availableVersion).toBeUndefined();
  });

  it("does not refetch inside the check interval unless forced", async () => {
    let t = 1_000_000;
    const { updater } = await setup({ now: () => t });
    await updater.checkForUpdates();
    // Point the manifest elsewhere by swapping state: the cached answer is served.
    const s = updater.readState();
    s.availableVersion = "9.9.9";
    updater.writeState(s);
    expect(await updater.checkForUpdates()).toBe("9.9.9");
    expect(await updater.checkForUpdates(true)).toBe("1.1.0");
    t += 25 * 60 * 60 * 1000;
    expect(await updater.checkForUpdates()).toBe("1.1.0");
  });

  it("downloads, verifies, swaps the binary, and links the alias", async () => {
    const { updater, files, links } = await setup();
    const res = await updater.performUpdate();
    expect(res).toEqual({ success: true, version: "1.1.0" });
    expect(new TextDecoder().decode(files.get("/opt/acme/acme")!)).toBe("NEW BINARY BYTES");
    expect(files.has("/opt/acme/acme.new")).toBe(false);
    expect(files.has("/opt/acme/acme.backup")).toBe(false);
    expect(links.get("/opt/acme/ac")).toBe("/opt/acme/acme");
  });

  it("rejects a checksum mismatch and leaves the old binary in place", async () => {
    const { updater, files } = await setup({ corrupt: true });
    const res = await updater.performUpdate();
    expect(res.success).toBe(false);
    expect(res.error).toBe("checksum_mismatch_darwin-arm64");
    expect(new TextDecoder().decode(files.get("/opt/acme/acme")!)).toBe("OLD");
    expect(files.has("/opt/acme/acme.new")).toBe(false);
  });

  it("refuses in dev mode", async () => {
    const { updater } = await setup();
    const dev = new Updater({
      productName: "Acme", binaryName: "acme", currentVersion: "1.0.0", releaseBaseUrl: BASE, stateDir: "/x",
      execPath: "/usr/local/bin/bun", fs: (updater as any).cfg.fs, fetch: (updater as any).cfg.fetch, log: () => {},
    });
    expect(dev.isDevMode()).toBe(true);
    expect(await dev.performUpdate()).toEqual({ success: false, error: "dev_mode" });
  });

  it("reports a missing platform binary", async () => {
    const { updater } = await setup();
    (updater as any).cfg.arch = "x64";
    expect((await updater.performUpdate()).error).toBe("no_binary_darwin-x64");
  });

  it("decide combines the manifest and the minimum version", async () => {
    expect((await (await setup({ min: "1.0.5" })).updater.decide())).toEqual({ kind: "forced", version: "1.1.0", minimum: "1.0.5" });
    expect((await (await setup({ min: null })).updater.decide())).toEqual({ kind: "available", version: "1.1.0" });
    expect((await (await setup({ current: "1.1.0" })).updater.decide())).toEqual({ kind: "none" });
  });

  it("remembers a failed install for the retry interval", async () => {
    let t = 1_000_000;
    const { updater } = await setup({ now: () => t });
    expect(updater.updateRecentlyFailed("1.1.0")).toBe(false);
    updater.recordUpdateFailure("1.1.0");
    expect(updater.updateRecentlyFailed("1.1.0")).toBe(true);
    expect(updater.updateRecentlyFailed("1.2.0")).toBe(false);
    t += 7 * 60 * 60 * 1000;
    expect(updater.updateRecentlyFailed("1.1.0")).toBe(false);
  });

  it("switches channels and reads the other manifest", async () => {
    const { updater } = await setup();
    expect(updater.getChannel().name).toBe("stable");
    updater.setChannel("beta");
    expect(updater.getChannel().name).toBe("beta");
    expect((await updater.fetchManifest())?.version).toBe("1.2.0-beta");
    updater.setChannel("nope");
    expect(updater.getChannel().name).toBe("stable");
  });

  it("formats the update notice with the product's command", async () => {
    const { updater } = await setup();
    expect(updater.updateNotice("1.1.0")).toContain("v1.0.0 -> v1.1.0");
    expect(updater.updateNotice("1.1.0")).toContain("'ac update'");
  });
});
