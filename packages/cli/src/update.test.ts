// The CLI's own update policy, exercised through the real Updater: the curl
// download is argv only, a manifest that names anything but a plain https
// asset on the release origin never reaches a download, and the darwin code
// signature gate holds signed clients to signed releases. Every side effect
// is injected; no process, network or file outside the fixture is touched.
import { describe, expect, it } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { publicKeyToBase64, sha256Hex, signManifest, type UpdaterFs } from "@platform/cli-kit/update";
import { DARWIN_SIGNING_TEAM, RELEASE_BASE_URL, RELEASE_MANIFEST_SIGNING, createCodecastUpdater, makeCurlDownload, makeDarwinSignatureCheck, UPDATE_IN_PROGRESS, updateLockPath } from "./update";
import { UPDATE_DEFER_RETRIES, UPDATE_DEFER_RETRY_MS, forcedUpdateWaits, selfUpdateOutcome, watchdogUpdateReport } from "./daemonSelfUpdate";
import { exclusiveUpdate, isReleaseRace, updateWithRetry } from "./updateRetry";

const enc = new TextEncoder();
const dec = new TextDecoder();
const NEW = enc.encode("NEW CODECAST BINARY");

// A test key stands in for the release key; the policy keeps production's
// `required`, so every manifest a test expects to load is signed like a release.
const TEST_KEY = generateKeyPairSync("ed25519");
const TEST_SIGNING = { keys: { "test-key": publicKeyToBase64(TEST_KEY.publicKey) }, required: RELEASE_MANIFEST_SIGNING.required };

/** Serves `manifest` as latest.json with a signature by the test key beside it (`sign: false` serves no signature). */
function releaseFetch(manifest: unknown, { sign = true } = {}) {
  const bytes = JSON.stringify(manifest);
  const sig = JSON.stringify({ signatures: [signManifest(enc.encode(bytes), TEST_KEY.privateKey.export({ type: "pkcs8", format: "pem" }) as string, "test-key")] });
  return (async (input: string | URL) => {
    const url = String(input);
    if (url === `${RELEASE_BASE_URL}/latest.json`) return new Response(bytes);
    if (url === `${RELEASE_BASE_URL}/latest.json.sig` && sign) return new Response(sig);
    return new Response("nf", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

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
  const fetch = releaseFetch(manifest);
  const updater = createCodecastUpdater({
    currentVersion: "1.0.0",
    stateDir: "/home/u/.codecast",
    fetch,
    manifestSigning: TEST_SIGNING,
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

describe("a download that raced the manifest is tried once more", () => {
  /** curl that lands `served[i]` on its i-th call (the last one after that). */
  function servingExec(calls: Call[], files: Map<string, Uint8Array>, served: Uint8Array[]) {
    return ((file: string, args: string[]) => {
      calls.push({ file, args: [...args] });
      files.set(args[args.indexOf("-o") + 1], served[Math.min(calls.length - 1, served.length - 1)]!);
      return args[args.length - 1];
    }) as unknown as typeof import("./proc.js").execFileSync;
  }
  const STALE = enc.encode("OLD CDN COPY OF THE BINARY");
  const noPause = async () => {};

  it("installs on the second run when the first download did not match the checksum", async () => {
    const calls: Call[] = [];
    let files!: Map<string, Uint8Array>;
    const h = await harness({}, ((f: string, a: string[]) => servingExec(calls, files, [STALE, NEW])(f, a)) as any);
    files = h.files;
    expect(await updateWithRetry(() => h.updater.performUpdate(), noPause)).toEqual({ success: true, version: "9.9.9" });
    expect(calls).toHaveLength(2);
    expect(h.installed()).toBe(dec.decode(NEW));
  });

  it("gives up with the checksum error after one retry, leaving the old binary", async () => {
    const calls: Call[] = [];
    let files!: Map<string, Uint8Array>;
    const h = await harness({}, ((f: string, a: string[]) => servingExec(calls, files, [STALE])(f, a)) as any);
    files = h.files;
    expect(await updateWithRetry(() => h.updater.performUpdate(), noPause)).toEqual({ success: false, error: "checksum_mismatch_darwin-arm64" });
    expect(calls).toHaveLength(2);
    expect(h.installed()).toBe("OLD");
  });

  it("does not retry a failure that is not a race", async () => {
    const calls: Call[] = [];
    const h = await harness({}, fakeExec(calls, new Map(), { fail: 22 }));
    expect((await updateWithRetry(() => h.updater.performUpdate(), noPause)).error).toBe("download_curl_22");
    expect(calls).toHaveLength(1);
  });

  it("names the race errors", () => {
    expect(isReleaseRace("checksum_mismatch_linux-x64")).toBe(true);
    expect(isReleaseRace("download_incomplete")).toBe(true);
    expect(isReleaseRace("download_curl_22")).toBe(false);
    expect(isReleaseRace(undefined)).toBe(false);
  });
});

describe("a floor no release reaches (ct-102483)", () => {
  it("a machine on the newest release waits instead of reinstalling it and restarting below the floor", () => {
    // Floor 1.1.400, newest release 1.1.306: installing puts 1.1.306 back, the
    // daemon restarts still below 1.1.400, and installs again every check.
    expect(forcedUpdateWaits("1.1.306", "1.1.306")).toBe(true);
    expect(forcedUpdateWaits("1.1.307", "1.1.306")).toBe(true);
    // Once latest.json moves, it installs.
    expect(forcedUpdateWaits("1.1.306", "1.1.307")).toBe(false);
    // Unread manifest: install, and the install reports why it failed.
    expect(forcedUpdateWaits("1.1.306", null)).toBe(false);
  });
});

describe("a self update another process is already installing", () => {
  // Each perform answers from the script in turn; waits are recorded, not slept.
  function run(script: Array<{ success: boolean; error?: string }>) {
    const waits: number[] = [];
    const deferrals: number[] = [];
    let performs = 0;
    const outcome = selfUpdateOutcome(async () => script[Math.min(performs++, script.length - 1)]!, {
      at: 5,
      wait: async (ms) => { waits.push(ms); },
      onDeferred: (n) => deferrals.push(n),
    });
    return { outcome, waits, deferrals, performs: () => performs };
  }
  const deferred = { success: false, error: UPDATE_IN_PROGRESS };

  it("is tried again a minute later, and installs once the other updater lets go", async () => {
    const r = run([deferred, deferred, { success: true }]);
    expect(await r.outcome).toBeNull();
    expect(r.performs()).toBe(3);
    expect(r.waits).toEqual([UPDATE_DEFER_RETRY_MS, UPDATE_DEFER_RETRY_MS]);
    expect(r.deferrals).toEqual([1, 2]);
  });

  it("fails the device row with a clear reason when the lock stays held, instead of installing forever", async () => {
    const r = run([deferred]);
    const failed = await r.outcome;
    expect(failed).toMatchObject({ state: "failed", at: 5 });
    expect(failed!.error).toContain("another updater (cast update, or a command's update check) held this install's update lock for 5 minutes");
    expect(r.performs()).toBe(UPDATE_DEFER_RETRIES + 1);
    expect(r.waits).toHaveLength(UPDATE_DEFER_RETRIES);
  });

  it("fails at once on any other error", async () => {
    expect(await run([{ success: false, error: "checksum_mismatch_darwin-arm64" }]).outcome).toEqual({ state: "failed", error: "checksum_mismatch_darwin-arm64", at: 5 });
    expect(await run([{ success: false }]).outcome).toEqual({ state: "failed", error: "unknown error", at: 5 });
  });

  it("the watchdog reports its force_update as deferred, not failed, while another process installs", () => {
    expect(watchdogUpdateReport(deferred)).toEqual({ result: "Deferred by watchdog: another process is updating this install" });
    expect(watchdogUpdateReport({ success: true })).toEqual({ result: "Updated by watchdog" });
    expect(watchdogUpdateReport({ success: false, error: "checksum_mismatch_darwin-arm64" })).toEqual({ error: "Watchdog update failed: checksum_mismatch_darwin-arm64" });
  });
});

describe("cast restart while another process updates this install", () => {
  // The restart action runs a real daemon, so its words are read from the source (the boot graph has no room for a
  // helper module): the in-progress case is named before the failure line, and the restart goes on after both.
  it("says the update is in progress, not that it failed, and restarts", () => {
    const restart = readFileSync(join(import.meta.dir, "index.ts"), "utf-8").split('program\n  .command("restart")')[1]?.split("program\n  .command(")[0] ?? "";
    const failedLine = restart.indexOf("Update failed");
    expect(failedLine).toBeGreaterThan(0);
    const branch = restart.slice(restart.lastIndexOf("} else {", failedLine), restart.indexOf("\n", failedLine));
    expect(branch).toContain('error === UPDATE_IN_PROGRESS ? "another update of this install is in progress; restarting without updating" : `Update failed');
    expect(restart.indexOf("startDaemon({ afterStop: true })")).toBeGreaterThan(failedLine);
  });
});

describe("two updaters on one install (ct-102415)", () => {
  // Real files on a temp install, and a download that streams like curl -o:
  // open (truncating) the fixed `<binary>.new`, write half, yield, write the
  // rest. Unlocked, the second updater deletes and truncates the first's
  // download mid-stream: one reads the other's half file (download_incomplete,
  // or a checksum mismatch), and the retry races the same way.
  const BIG = enc.encode("NEW CODECAST BINARY ".repeat(4096));
  async function install(dir: string) {
    const exe = join(dir, "codecast");
    writeFileSync(exe, "OLD");
    const manifest = {
      version: "9.9.9",
      released: "2026-09-23T00:00:00Z",
      binaries: { "darwin-arm64": { url: `${RELEASE_BASE_URL}/cli/releases/v9.9.9/abc/codecast-darwin-arm64`, sha256: await sha256Hex(BIG), size: BIG.byteLength } },
    };
    const download = async (_url: string, dest: string) => {
      const fd = openSync(dest, "w");
      try {
        writeSync(fd, BIG.subarray(0, BIG.byteLength / 2));
        await new Promise((r) => setTimeout(r, 20));
        writeSync(fd, BIG.subarray(BIG.byteLength / 2));
      } finally {
        closeSync(fd);
      }
    };
    const updater = () =>
      createCodecastUpdater({
        currentVersion: "1.0.0",
        stateDir: join(dir, "state"),
        fetch: releaseFetch(manifest),
        manifestSigning: TEST_SIGNING,
        execPath: exe,
        platform: "darwin",
        arch: "arm64",
        log: () => {},
        download,
        verifyPlatformSignature: async () => ({ ok: true }),
      });
    return { exe, updater };
  }
  const noPause = async () => {};

  it("serialize: one installs, the other skips the round, and the binary is the release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cast-update-race-"));
    try {
      const { exe, updater } = await install(dir);
      // Beside the binary whose `<binary>.new` it guards, whatever config dir each updater runs with.
      const lock = updateLockPath(exe);
      expect(lock).toBe(`${exe}.update.lock`);
      // The lock adds no signal handler: the daemon's own SIGTERM handler must run once, not again re-raised by the lock.
      const handlers = () => ["SIGINT", "SIGTERM", "SIGHUP"].map((s) => process.listenerCount(s as NodeJS.Signals));
      const before = handlers();
      const during: number[][] = [];
      const run = (u: ReturnType<typeof updater>) => exclusiveUpdate(lock, () => { during.push(handlers()); return updateWithRetry(() => u.performUpdate(), noPause); });
      const results = await Promise.all([run(updater()), run(updater())]);
      expect(during).toEqual([before]);
      expect(results.filter((r) => r.success)).toHaveLength(1);
      expect(results.filter((r) => !r.success).map((r) => r.error)).toEqual([UPDATE_IN_PROGRESS]);
      expect(readFileSync(exe)).toEqual(Buffer.from(BIG));
      // The lock is released: the next round runs.
      expect((await run(updater())).success).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("control: unlocked, the same two updaters break each other's download, so the fixture still races", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cast-update-race-"));
    try {
      const { updater } = await install(dir);
      const run = (u: ReturnType<typeof updater>) => updateWithRetry(() => u.performUpdate(), noPause);
      const results = await Promise.all([run(updater()), run(updater())]);
      expect(results.filter((r) => r.success).length).toBeLessThan(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a lock that cannot be written beside the binary runs the update anyway, so its own failure is reported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cast-update-ro-"));
    try {
      chmodSync(dir, 0o555);
      let ran = false;
      const result = await exclusiveUpdate(join(dir, "codecast.update.lock"), async () => { ran = true; return { success: false, error: "permission denied" }; });
      expect(ran).toBe(true);
      expect(result).toEqual({ success: false, error: "permission denied" });
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reclaims a lock left by a dead updater", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cast-update-race-"));
    try {
      const { exe, updater } = await install(dir);
      const lock = join(dir, "update.lock");
      writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 17, at: Date.now(), token: "dead" }));
      expect((await exclusiveUpdate(lock, () => updater().performUpdate())).success).toBe(true);
      expect(readFileSync(exe)).toEqual(Buffer.from(BIG));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("release manifest signature", () => {
  const manifest = { version: "9.9.9", released: "2026-11-10T00:00:00Z", binaries: { "darwin-arm64": { url: `${RELEASE_BASE_URL}/codecast-darwin-arm64`, sha256: "00".repeat(32) } } };
  const load = (fetch: typeof globalThis.fetch, manifestSigning = RELEASE_MANIFEST_SIGNING) =>
    (createCodecastUpdater({ currentVersion: "1.0.0", stateDir: "/s", fs: memFs({}).fs, fetch, manifestSigning, log: () => {} }) as any).loadManifest();

  it("is required: an unsigned latest.json is refused before anything downloads", async () => {
    expect(RELEASE_MANIFEST_SIGNING.required).toBe(true);
    expect(await load(releaseFetch(manifest, { sign: false }))).toEqual({ ok: false, error: "manifest_signature_missing" });
  });

  it("refuses a manifest signed only by a key the client does not pin", async () => {
    expect(await load(releaseFetch(manifest))).toEqual({ ok: false, error: "manifest_signature_unknown_key" });
  });

  it("accepts a manifest signed by a pinned key", async () => {
    expect((await load(releaseFetch(manifest), TEST_SIGNING)).ok).toBe(true);
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
    expect(await makeDarwinSignatureCheck({ platform: "darwin", execPath: "/opt/old", spawn: fakeSpawn(signed) })("/opt/new")).toEqual({ ok: false, reason: "unreadable" });
    expect(await makeDarwinSignatureCheck({ platform: "darwin", execPath: "/opt/old", spawn: fakeSpawn({ ...signed, "/opt/new": DARWIN_SIGNING_TEAM }, false) })("/opt/new")).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses the swap through the real updater when the gate says no", async () => {
    const { fs, files } = memFs({ "/opt/codecast/codecast": "OLD" });
    const sha = await sha256Hex(NEW);
    const fetch = releaseFetch({ version: "9.9.9", released: "", binaries: { "darwin-arm64": { url: `${RELEASE_BASE_URL}/codecast-darwin-arm64`, sha256: sha } } });
    const updater = createCodecastUpdater({
      currentVersion: "1.0.0", stateDir: "/s", fetch, fs, manifestSigning: TEST_SIGNING, execPath: "/opt/codecast/codecast", platform: "darwin", arch: "arm64", log: () => {},
      download: async (_u, dest) => void files.set(dest, NEW),
      // The download lands at a name the updater picks, so every file but the
      // running binary carries the foreign team.
      verifyPlatformSignature: makeDarwinSignatureCheck({ platform: "darwin", execPath: "/opt/codecast/codecast", spawn: fakeSpawn(new Proxy({}, { get: (_, file) => file === "/opt/codecast/codecast" ? DARWIN_SIGNING_TEAM : "EVIL123456" })) }),
    });
    const res = await updater.performUpdate();
    expect(res).toEqual({ success: false, error: "platform_signature_wrong_team" });
    expect(dec.decode(files.get("/opt/codecast/codecast")!)).toBe("OLD");
    expect([...files.keys()].filter((k) => k.startsWith("/opt/codecast/codecast."))).toEqual([]);
  });
});
