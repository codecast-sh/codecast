import { describe, expect, it } from "bun:test";
import { Updater, type UpdaterConfig, type UpdaterFs } from "./updater";
import { sha256Hex } from "./checksum";

// An in memory file system and fetch so the whole update path runs under test.
function memFs(initial: Record<string, Uint8Array | string> = {}) {
  const files = new Map<string, Uint8Array>();
  const links = new Map<string, string>();
  const dirs = new Set<string>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  for (const [k, v] of Object.entries(initial)) files.set(k, typeof v === "string" ? enc.encode(v) : v);
  const failRename = new Set<string>();
  const fs: UpdaterFs = {
    existsSync: (p) => files.has(p) || dirs.has(p) || links.has(p),
    readFileSync: (p) => {
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return f;
    },
    readTextSync: (p) => dec.decode(fs.readFileSync(p)),
    writeTextSync: (p, t) => void files.set(p, enc.encode(t)),
    writeFileSync: (p, bytes) => void files.set(p, bytes),
    mkdirSync: (p) => void dirs.add(p),
    unlinkSync: (p) => {
      if (links.delete(p)) return;
      if (!files.delete(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    renameSync: (a, b) => {
      // One shot: the fault hits the first rename onto that path only, so a
      // restore of the same path afterwards goes through.
      if (failRename.delete(b)) throw new Error(`rename: EACCES ${b}`);
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
  return { fs, files, links, failRename };
}

type Route = { status?: number; body: unknown | Uint8Array; headers?: Record<string, string> };
function fakeFetch(routes: Record<string, Route>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const r = routes[url];
    if (!r) return new Response("nf", { status: 404 });
    const status = r.status ?? 200;
    if (r.body instanceof Uint8Array) return new Response(r.body as unknown as BodyInit, { status, headers: r.headers });
    return new Response(JSON.stringify(r.body), { status, headers: r.headers });
  }) as unknown as typeof fetch;
}

const BASE = "https://dl.example.com";
const newBinary = new TextEncoder().encode("NEW BINARY BYTES");

interface SetupOpts {
  current?: string;
  latest?: string;
  corrupt?: boolean;
  min?: string | null;
  now?: () => number;
  /** Override the manifest's binary entry for darwin-arm64. */
  entry?: Partial<{ url: string; sha256: string; size: number }>;
  /** Extra fetch routes (redirect chains, alternate hosts). */
  routes?: Record<string, Route>;
  /** Use the package's own fetch based download instead of the injected one. */
  defaultDownload?: boolean;
  maxBinaryBytes?: number;
}

async function setup(opts: SetupOpts = {}) {
  const sha = await sha256Hex(newBinary);
  const { fs, files, links, failRename } = memFs({ "/opt/acme/acme": "OLD" });
  let downloaded = 0;
  const seen: string[] = [];
  const binaryUrl = `${BASE}/acme-darwin-arm64`;
  const fetch = fakeFetch(
    {
      [`${BASE}/latest.json`]: {
        body: {
          version: opts.latest ?? "1.1.0",
          released: "2026-01-01T00:00:00Z",
          binaries: {
            "darwin-arm64": { url: binaryUrl, sha256: opts.corrupt ? "00".repeat(32) : sha, ...opts.entry },
          },
        },
      },
      [`${BASE}/latest-beta.json`]: { body: { version: "1.2.0-beta", released: "", binaries: {} } },
      [binaryUrl]: { body: newBinary },
      ...opts.routes,
    },
    seen,
  );
  const config: UpdaterConfig = {
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
    execPath: "/opt/acme/acme",
    platform: "darwin",
    arch: "arm64",
    now: opts.now ?? (() => 1_000_000),
    log: () => {},
    maxBinaryBytes: opts.maxBinaryBytes,
  };
  if (!opts.defaultDownload) {
    config.download = async (_url, dest) => {
      downloaded++;
      files.set(dest, newBinary);
    };
  }
  const updater = new Updater(config);
  const installed = () => new TextDecoder().decode(files.get("/opt/acme/acme")!);
  return { updater, files, links, failRename, seen, installed, downloads: () => downloaded };
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
    const { updater, files, links, installed } = await setup();
    const res = await updater.performUpdate();
    expect(res).toEqual({ success: true, version: "1.1.0" });
    expect(installed()).toBe("NEW BINARY BYTES");
    expect(files.has("/opt/acme/acme.new")).toBe(false);
    expect(files.has("/opt/acme/acme.backup")).toBe(false);
    expect(links.get("/opt/acme/ac")).toBe("/opt/acme/acme");
  });

  it("downloads through the package's own fetch path and verifies", async () => {
    const { updater, installed } = await setup({ defaultDownload: true });
    expect(await updater.performUpdate()).toEqual({ success: true, version: "1.1.0" });
    expect(installed()).toBe("NEW BINARY BYTES");
  });

  it("rejects a checksum mismatch and leaves the old binary in place", async () => {
    const { updater, files, installed } = await setup({ corrupt: true });
    const res = await updater.performUpdate();
    expect(res.success).toBe(false);
    expect(res.error).toBe("checksum_mismatch_darwin-arm64");
    expect(installed()).toBe("OLD");
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

describe("Updater refuses a manifest it cannot trust before anything is downloaded", () => {
  const cases: Array<[string, Partial<{ url: string; sha256: string; size: number }>, string]> = [
    ["another origin", { url: "https://evil.example.net/acme-darwin-arm64" }, "bad_binary_url_darwin-arm64"],
    ["plain http", { url: "http://dl.example.com/acme-darwin-arm64" }, "bad_binary_url_darwin-arm64"],
    ["a lookalike host", { url: "https://dl.example.com.evil.net/acme-darwin-arm64" }, "bad_binary_url_darwin-arm64"],
    ["shell metacharacters", { url: `${BASE}/acme"; touch /tmp/pwn; "` }, "bad_binary_url_darwin-arm64"],
    ["command substitution", { url: `${BASE}/acme$(id)` }, "bad_binary_url_darwin-arm64"],
    ["a malformed digest", { sha256: "not-a-digest" }, "bad_digest_darwin-arm64"],
    ["a digest with a prefix", { sha256: `sha256:${"ab".repeat(32)}` }, "bad_digest_darwin-arm64"],
    ["a declared size above the bound", { size: 10 * 1024 * 1024 * 1024 }, "bad_size_darwin-arm64"],
  ];
  for (const [name, entry, error] of cases) {
    it(`refuses ${name} and never calls download`, async () => {
      const { updater, installed, downloads, files } = await setup({ entry });
      const res = await updater.performUpdate();
      expect(res.success).toBe(false);
      expect(res.error).toBe(error);
      expect(downloads()).toBe(0);
      expect(installed()).toBe("OLD");
      expect(files.has("/opt/acme/acme.new")).toBe(false);
    });
  }

  it("refuses a manifest whose version is not a version", async () => {
    const { updater, downloads } = await setup({ latest: "1.1.0; rm -rf /" });
    const res = await updater.performUpdate();
    expect(res.success).toBe(false);
    expect(res.error).toBe("bad_manifest");
    expect(downloads()).toBe(0);
  });
});

describe("Updater's own download", () => {
  it("follows a same-origin https redirect and refuses one that leaves the origin", async () => {
    const good = await setup({
      defaultDownload: true,
      entry: { url: `${BASE}/latest/acme` },
      routes: { [`${BASE}/latest/acme`]: { status: 302, body: "", headers: { location: "/acme-darwin-arm64" } } },
    });
    expect(await good.updater.performUpdate()).toEqual({ success: true, version: "1.1.0" });
    expect(good.seen).toContain(`${BASE}/acme-darwin-arm64`);

    const bad = await setup({
      defaultDownload: true,
      entry: { url: `${BASE}/latest/acme` },
      routes: {
        [`${BASE}/latest/acme`]: { status: 302, body: "", headers: { location: "https://mirror.example.net/acme" } },
        "https://mirror.example.net/acme": { body: newBinary },
      },
    });
    const res = await bad.updater.performUpdate();
    expect(res.success).toBe(false);
    expect(res.error).toBe("download_redirect_refused");
    expect(bad.seen).not.toContain("https://mirror.example.net/acme");
    expect(bad.installed()).toBe("OLD");
  });

  it("refuses a redirect to plain http", async () => {
    const { updater, seen, installed } = await setup({
      defaultDownload: true,
      entry: { url: `${BASE}/latest/acme` },
      routes: {
        [`${BASE}/latest/acme`]: { status: 302, body: "", headers: { location: "http://dl.example.com/acme-darwin-arm64" } },
        "http://dl.example.com/acme-darwin-arm64": { body: newBinary },
      },
    });
    expect((await updater.performUpdate()).error).toBe("download_redirect_refused");
    expect(seen).not.toContain("http://dl.example.com/acme-darwin-arm64");
    expect(installed()).toBe("OLD");
  });

  it("gives up on a redirect loop", async () => {
    const { updater, installed } = await setup({
      defaultDownload: true,
      entry: { url: `${BASE}/a` },
      routes: {
        [`${BASE}/a`]: { status: 302, body: "", headers: { location: "/b" } },
        [`${BASE}/b`]: { status: 302, body: "", headers: { location: "/a" } },
      },
    });
    expect((await updater.performUpdate()).error).toBe("download_too_many_redirects");
    expect(installed()).toBe("OLD");
  });

  it("refuses a body larger than the bound, declared or not", async () => {
    const big = new Uint8Array(64);
    const declared = await setup({
      defaultDownload: true,
      maxBinaryBytes: 32,
      routes: { [`${BASE}/acme-darwin-arm64`]: { body: big, headers: { "content-length": "64" } } },
    });
    expect((await declared.updater.performUpdate()).error).toBe("download_too_large");
    expect(declared.installed()).toBe("OLD");

    const undeclared = await setup({ defaultDownload: true, maxBinaryBytes: 32, routes: { [`${BASE}/acme-darwin-arm64`]: { body: big } } });
    expect((await undeclared.updater.performUpdate()).error).toBe("download_too_large");
    expect(undeclared.installed()).toBe("OLD");
  });

  it("refuses a partial download", async () => {
    const { updater, installed, files } = await setup({
      defaultDownload: true,
      routes: { [`${BASE}/acme-darwin-arm64`]: { body: newBinary, headers: { "content-length": String(newBinary.length + 100) } } },
    });
    expect((await updater.performUpdate()).error).toBe("download_incomplete");
    expect(installed()).toBe("OLD");
    expect(files.has("/opt/acme/acme.new")).toBe(false);
  });

  it("refuses a download that answers with an error status", async () => {
    const { updater, installed } = await setup({ defaultDownload: true, routes: { [`${BASE}/acme-darwin-arm64`]: { status: 500, body: "" } } });
    expect((await updater.performUpdate()).error).toBe("download_500");
    expect(installed()).toBe("OLD");
  });
});

describe("Updater keeps a runnable binary when the swap is interrupted", () => {
  it("puts the old binary back when the new one cannot take its place", async () => {
    const { updater, failRename, installed, files } = await setup();
    failRename.add("/opt/acme/acme"); // the second rename (new -> current) fails
    const res = await updater.performUpdate();
    expect(res.success).toBe(false);
    expect(installed()).toBe("OLD");
    expect(files.has("/opt/acme/acme.backup")).toBe(false);
    expect(files.has("/opt/acme/acme.new")).toBe(false);
  });

  it("refuses to overwrite when a downloaded file is larger than the bound", async () => {
    const { updater, installed } = await setup({ maxBinaryBytes: 4 });
    const res = await updater.performUpdate();
    expect(res.error).toBe("download_too_large");
    expect(installed()).toBe("OLD");
  });
});
