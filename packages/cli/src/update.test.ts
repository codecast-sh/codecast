// The CLI's own update policy, exercised through the real Updater: the curl
// download is argv only, a manifest that names anything but a plain https
// asset on the release origin never reaches a download, and the darwin code
// signature gate holds signed clients to signed releases. Every side effect
// is injected; no process, network or file outside the fixture is touched.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, type UpdaterFs } from "@platform/cli-kit/update";
import { DARWIN_SIGNING_TEAM, RELEASE_BASE_URL, createCodecastUpdater, makeCurlDownload, makeDarwinSignatureCheck } from "./update";

const enc = new TextEncoder();
const dec = new TextDecoder();
const NEW = enc.encode("NEW CODECAST BINARY");

function memFs(initial: Record<string, string>) {
  const files = new Map<string, Uint8Array>();
  const links = new Map<string, string>();
  for (const [k, v] of Object.entries(initial)) files.set(k, enc.encode(v));
  const fs: UpdaterFs = {
    existsSync: (p) => files.has(p) || links.has(p),
    readFileSync: (p) => {
      const f = files.get(p);
      if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return f;
    },
    readTextSync: (p) => dec.decode(fs.readFileSync(p)),
    writeTextSync: (p, t) => void files.set(p, enc.encode(t)),
    writeFileSync: (p, b) => void files.set(p, b),
    mkdirSync: () => {},
    unlinkSync: (p) => {
      if (links.delete(p)) return;
      if (!files.delete(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    renameSync: (a, b) => {
      const f = files.get(a);
      if (!f) throw new Error(`missing ${a}`);
      files.delete(a);
      files.set(b, f);
    },
    chmodSync: () => {},
    readlinkSync: (p) => {
      const t = links.get(p);
      if (!t) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return t;
    },
    symlinkSync: (t, l) => void links.set(l, t),
  };
  return { fs, files };
}

type Call = { file: string; args: string[] };

/** A recording stand-in for proc.execFileSync: no process is started. */
function fakeExec(calls: Call[], files: Map<string, Uint8Array>, opts: { effective?: string; fail?: number } = {}) {
  return ((file: string, args: string[]) => {
    calls.push({ file, args: [...args] });
    if (opts.fail !== undefined) throw Object.assign(new Error("curl failed"), { status: opts.fail });
    const dest = args[args.indexOf("-o") + 1];
    files.set(dest, NEW);
    return opts.effective ?? args[args.length - 1];
  }) as unknown as typeof import("./proc.js").execFileSync;
}

async function harness(manifestEntry: Partial<{ url: string; sha256: string; size: number }> = {}, exec?: ReturnType<typeof fakeExec>) {
  const sha = await sha256Hex(NEW);
  const { fs, files } = memFs({ "/opt/codecast/codecast": "OLD" });
  const calls: Call[] = [];
  const manifest = {
    version: "9.9.9",
    released: "2026-09-23T00:00:00Z",
    binaries: { "darwin-arm64": { url: `${RELEASE_BASE_URL}/cli/releases/v9.9.9/abc/codecast-darwin-arm64`, sha256: sha, ...manifestEntry } },
  };
  const fetch = (async (input: string | URL) => {
    if (String(input) === `${RELEASE_BASE_URL}/latest.json`) return new Response(JSON.stringify(manifest));
    return new Response("nf", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const updater = createCodecastUpdater({
    currentVersion: "1.0.0",
    stateDir: "/home/u/.codecast",
    fetch,
    fs,
    execPath: "/opt/codecast/codecast",
    platform: "darwin",
    arch: "arm64",
    log: () => {},
    download: makeCurlDownload(exec ?? fakeExec(calls, files)),
    verifyPlatformSignature: async () => ({ ok: true }),
  });
  return { updater, calls, files, installed: () => dec.decode(files.get("/opt/codecast/codecast")!) };
}

describe("cast update download", () => {
  it("runs curl with argv, https on every hop, a redirect cap and a size cap", async () => {
    const { updater, calls, installed } = await harness();
    expect(await updater.performUpdate()).toEqual({ success: true, version: "9.9.9" });
    expect(installed()).toBe(dec.decode(NEW));
    expect(calls).toHaveLength(1);
    const { file, args } = calls[0]!;
    expect(file).toBe("curl");
    expect(args).toContain("--proto");
    expect(args[args.indexOf("--proto") + 1]).toBe("=https");
    expect(args[args.indexOf("--proto-redir") + 1]).toBe("=https");
    expect(args[args.indexOf("--max-redirs") + 1]).toBe("3");
    expect(Number(args[args.indexOf("--max-filesize") + 1])).toBeGreaterThan(100 * 1024 * 1024);
    expect(args[args.length - 1]).toBe(`${RELEASE_BASE_URL}/cli/releases/v9.9.9/abc/codecast-darwin-arm64`);
  });

  it("passes a hostile URL as one literal argument and never a shell line", async () => {
    const calls: Call[] = [];
    const files = new Map<string, Uint8Array>();
    const hostile = `https://dl.codecast.sh/x"; touch /tmp/pwn; echo "$(id)`;
    const download = makeCurlDownload(fakeExec(calls, files, { effective: hostile }));
    await download(hostile, "/tmp/dest", { maxBytes: 1024, origin: RELEASE_BASE_URL });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("curl");
    expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe(hostile);
    expect(calls[0]!.args.join(" ")).not.toContain("sh -c");
  });

  it("refuses to start curl for anything but https", async () => {
    const calls: Call[] = [];
    const download = makeCurlDownload(fakeExec(calls, new Map()));
    for (const url of ["http://dl.codecast.sh/x", "file:///etc/passwd", "-o/etc/passwd", "ftp://dl.codecast.sh/x"]) {
      await expect(download(url, "/tmp/dest", { maxBytes: 1024, origin: RELEASE_BASE_URL })).rejects.toThrow("download_not_https");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses bytes that curl read from another origin and removes them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cast-update-"));
    try {
      const dest = join(dir, "codecast.new");
      const calls: Call[] = [];
      const files = new Map<string, Uint8Array>();
      const exec = ((file: string, args: string[]) => {
        calls.push({ file, args });
        writeFileSync(dest, NEW);
        return "https://mirror.example.net/codecast-darwin-arm64";
      }) as unknown as typeof import("./proc.js").execFileSync;
      void files;
      const download = makeCurlDownload(exec);
      await expect(download(`${RELEASE_BASE_URL}/x`, dest, { maxBytes: 1024, origin: RELEASE_BASE_URL })).rejects.toThrow("download_redirect_refused");
      expect(() => readFileSync(dest)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports curl's exit status without echoing the command line", async () => {
    const calls: Call[] = [];
    const download = makeCurlDownload(fakeExec(calls, new Map(), { fail: 63 }));
    await expect(download(`${RELEASE_BASE_URL}/x`, "/tmp/dest", { maxBytes: 1, origin: RELEASE_BASE_URL })).rejects.toThrow("download_curl_63");
  });
});

describe("cast update refuses a manifest it cannot trust before curl runs", () => {
  const cases: Array<[string, Partial<{ url: string; sha256: string; size: number }>, string]> = [
    ["a URL off the release origin", { url: "https://dl.codecast.sh.evil.net/codecast-darwin-arm64" }, "bad_binary_url_darwin-arm64"],
    ["a plain http URL", { url: "http://dl.codecast.sh/codecast-darwin-arm64" }, "bad_binary_url_darwin-arm64"],
    ["shell metacharacters in the URL", { url: `${RELEASE_BASE_URL}/codecast"; touch /tmp/pwn; "` }, "bad_binary_url_darwin-arm64"],
    ["command substitution in the URL", { url: `${RELEASE_BASE_URL}/codecast$(id)` }, "bad_binary_url_darwin-arm64"],
    ["a URL with credentials", { url: "https://a:b@dl.codecast.sh/codecast-darwin-arm64" }, "bad_binary_url_darwin-arm64"],
    ["a malformed digest", { sha256: "$(id)" }, "bad_digest_darwin-arm64"],
    ["an oversize declared asset", { size: 4 * 1024 * 1024 * 1024 }, "bad_size_darwin-arm64"],
  ];
  for (const [name, entry, error] of cases) {
    it(`refuses ${name}`, async () => {
      const { updater, calls, installed } = await harness(entry);
      const res = await updater.performUpdate();
      expect(res.success).toBe(false);
      expect(res.error).toBe(error);
      expect(calls).toHaveLength(0);
      expect(installed()).toBe("OLD");
    });
  }

  it("refuses a wrong digest after download and keeps the old binary", async () => {
    const { updater, calls, installed } = await harness({ sha256: "00".repeat(32) });
    const res = await updater.performUpdate();
    expect(res.error).toBe("checksum_mismatch_darwin-arm64");
    expect(calls).toHaveLength(1);
    expect(installed()).toBe("OLD");
  });

  it("accepts today's published manifest shape", async () => {
    // The live manifest carries version, released, sourceCommit and five
    // entries of url + sha256 on the release origin; no size, no signature.
    const live = readFileSync(join(import.meta.dir, "__fixtures__/latest.json.example"), "utf8");
    const manifest = JSON.parse(live);
    const { updater } = await harness();
    const loaded = await (updater as any).loadManifest();
    expect(loaded.ok).toBe(true);
    for (const key of Object.keys(manifest.binaries)) {
      const res = (await import("@platform/cli-kit/update")).checkBinaryEntry(manifest.binaries[key], { releaseBaseUrl: RELEASE_BASE_URL, maxBytes: 512 * 1024 * 1024 });
      expect(res.ok, key).toBe(true);
    }
  });
});

describe("darwin code signature gate", () => {
  type Spawned = { file: string; args: string[] };
  function fakeSpawn(teams: Record<string, string | null>, verifyOk = true, seen: Spawned[] = []) {
    return ((file: string, args: string[]) => {
      seen.push({ file, args });
      const target = args[args.length - 1]!;
      if (args[0] === "--verify") return { status: verifyOk ? 0 : 1, stdout: "", stderr: "" };
      const team = teams[target];
      if (team === undefined) return { status: 1, stdout: "", stderr: "code object is not signed at all" };
      return { status: 0, stdout: "", stderr: team ? `Identifier=sh.codecast.cli\nTeamIdentifier=${team}\n` : "Identifier=sh.codecast.cli\n" };
    }) as unknown as typeof import("./proc.js").spawnSync;
  }

  it("is a no-op off darwin", async () => {
    const seen: Spawned[] = [];
    const check = makeDarwinSignatureCheck({ platform: "linux", spawn: fakeSpawn({}, true, seen) });
    expect(await check("/x")).toEqual({ ok: true });
    expect(seen).toHaveLength(0);
  });

  it("lets an unsigned or dev running binary keep updating", async () => {
    const check = makeDarwinSignatureCheck({ platform: "darwin", execPath: "/opt/old", spawn: fakeSpawn({ "/opt/old": null, "/opt/new": null }) });
    expect(await check("/opt/new")).toEqual({ ok: true });
    const adhoc = makeDarwinSignatureCheck({ platform: "darwin", execPath: "/opt/old", spawn: fakeSpawn({ "/opt/new": null }) });
    expect(await adhoc("/opt/new")).toEqual({ ok: true });
  });

  it("holds a signed running binary to a valid signature by the same team", async () => {
    const signed = { "/opt/old": DARWIN_SIGNING_TEAM };
    expect(await makeDarwinSignatureCheck({ platform: "darwin", execPath: "/opt/old", spawn: fakeSpawn({ ...signed, "/opt/new": DARWIN_SIGNING_TEAM }) })("/opt/new")).toEqual({ ok: true });
    expect(await makeDarwinSignatureCheck({ platform: "darwin", execPath: "/opt/old", spawn: fakeSpawn({ ...signed, "/opt/new": "EVIL123456" }) })("/opt/new")).toEqual({ ok: false, reason: "wrong_team" });
    expect(await makeDarwinSignatureCheck({ platform: "darwin", execPath: "/opt/old", spawn: fakeSpawn({ ...signed, "/opt/new": null }) })("/opt/new")).toEqual({ ok: false, reason: "wrong_team" });
    expect(await makeDarwinSignatureCheck({ platform: "darwin", execPath: "/opt/old", spawn: fakeSpawn({ ...signed, "/opt/new": DARWIN_SIGNING_TEAM }, false) })("/opt/new")).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses the swap through the real updater when the gate says no", async () => {
    const { fs, files } = memFs({ "/opt/codecast/codecast": "OLD" });
    const sha = await sha256Hex(NEW);
    const fetch = (async () => new Response(JSON.stringify({ version: "9.9.9", released: "", binaries: { "darwin-arm64": { url: `${RELEASE_BASE_URL}/codecast-darwin-arm64`, sha256: sha } } }))) as unknown as typeof globalThis.fetch;
    const updater = createCodecastUpdater({
      currentVersion: "1.0.0", stateDir: "/s", fetch, fs, execPath: "/opt/codecast/codecast", platform: "darwin", arch: "arm64", log: () => {},
      download: async (_u, dest) => void files.set(dest, NEW),
      verifyPlatformSignature: makeDarwinSignatureCheck({ platform: "darwin", execPath: "/opt/codecast/codecast", spawn: fakeSpawn({ "/opt/codecast/codecast": DARWIN_SIGNING_TEAM, "/opt/codecast/codecast.new": "EVIL123456" }) }),
    });
    const res = await updater.performUpdate();
    expect(res).toEqual({ success: false, error: "platform_signature_wrong_team" });
    expect(dec.decode(files.get("/opt/codecast/codecast")!)).toBe("OLD");
    expect(files.has("/opt/codecast/codecast.new")).toBe(false);
  });
});
