import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { convergenceState, recordConvergenceSignals, resetConvergenceState } from "./heartbeat.js";
import { reconcileFromHeartbeat, type KitAppliedItem } from "./reconcile.js";
import { folderHash, packArchive, type StoreFile } from "./contentStore.js";
import { kitLedgerPath } from "./kitInstall.js";
import { locateKitItem, publishKitPackage } from "./kitPublish.js";
import * as zlib from "zlib";

/** A real, valid 4x4 RGBA PNG: signature, IHDR, IDAT, IEND with CRCs. */
function png(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: 4 }, (_, y) => Buffer.from([0, ...Array.from({ length: 16 }, (_, i) => (y * 61 + i * 37 + 200) & 0xff)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

// Each pass shells out to git for the project key; a loaded machine needs headroom.
setDefaultTimeout(30_000);

const dirs: string[] = [];
function tmpHome(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-kitrec-")));
  dirs.push(d);
  return d;
}
let revision = 0;
beforeEach(() => resetConvergenceState());
afterEach(() => {
  resetConvergenceState();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const f = (p: string, text: string, executable = false): StoreFile => ({ path: p, bytes: Buffer.from(text), executable });

interface KitVersion {
  kind: string;
  name: string;
  files: StoreFile[];
  surfaces: string[];
  main_body?: string;
  workspace?: string;
  archive?: Buffer;
}

/** A fake codecast server: bindings, versions, consents, the applied report
 *  and archive downloads, all mutable between passes. */
function fakeServer() {
  const state = {
    bindings: new Map<string, boolean>(),
    versions: new Map<string, KitVersion>(),
    consents: [] as Array<{ capability_slug: string; manifest_hash: string }>,
    adoptions: [] as Array<{ slug: string; hash: string }>,
    applied: [] as KitAppliedItem[][],
    versionDown: false,
  };
  const fetchImpl = (async (url: string, init: any) => {
    const u = String(url);
    if (u.startsWith("https://files.test/")) {
      const v = state.versions.get(decodeURIComponent(u.slice("https://files.test/".length)))!;
      return new Response(new Uint8Array(v.archive ?? packArchive(v.files)));
    }
    const route = u.replace("https://site.test", "");
    const body = JSON.parse(init.body);
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
    if (route === "/cli/cap/bindings") {
      return json([...state.bindings].map(([slug, enabled]) => ({ capability_slug: slug, scope_kind: "user", scope_key: "", enabled, updated_at: 1 })));
    }
    if (route === "/cli/cap/kit/version") {
      if (state.versionDown) return json({ error: "backend unavailable" }, 500);
      const v = state.versions.get(body.slug);
      if (!v) return json(null);
      return json({
        slug: body.slug,
        kind: v.kind,
        name: v.name,
        workspace: v.workspace ?? "team:t1",
        folder_hash: folderHash(v.files),
        surfaces: v.surfaces,
        main_body: v.main_body ?? v.files[0]!.bytes.toString(),
        download_url: `https://files.test/${encodeURIComponent(body.slug)}`,
      });
    }
    if (route === "/cli/cap/consents") return json(state.consents);
    if (route === "/cli/cap/kit/adoptions") return json(state.adoptions);
    if (route === "/cli/cap/kit/applied") {
      state.applied.push(body.items);
      return json({ status: "recorded" });
    }
    if (route === "/cli/teams") return json({ teams: [{ _id: "t1", name: "Acme" }] });
    return json({ error: `unexpected ${route}` }, 404);
  }) as unknown as typeof fetch;
  return { state, fetchImpl };
}

async function pass(home: string, server: ReturnType<typeof fakeServer>) {
  recordConvergenceSignals({ capabilities_mode: "on", capability_desired_revision: ++revision });
  const lines: string[] = [];
  const out = await reconcileFromHeartbeat({
    siteUrl: "https://site.test",
    apiToken: "tok",
    userId: "u1",
    home,
    deviceId: "dev1",
    fetchImpl: server.fetchImpl,
    log: (l) => lines.push(l),
  });
  return { out, lines, report: server.state.applied.at(-1) ?? [] };
}

const SKILL = "authored/t1/skill/deploy";
const PROSE_SKILL: KitVersion = { kind: "skill", name: "deploy", surfaces: ["prose"], files: [f("SKILL.md", "---\nname: deploy\n---\nDeploy carefully.\n"), f("reference/notes.md", "Notes.\n")] };

describe("the reconciler installs the kit", () => {
  test("a prose skill installs without asking: shared dir, Claude link, ledger, report", async () => {
    const home = tmpHome();
    const server = fakeServer();
    server.state.bindings.set(SKILL, true);
    server.state.versions.set(SKILL, PROSE_SKILL);

    const { out, report } = await pass(home, server);
    const dir = path.join(home, ".agents", "skills", "deploy");
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toContain("Deploy carefully.");
    expect(fs.readFileSync(path.join(dir, "reference", "notes.md"), "utf-8")).toBe("Notes.\n");
    const link = path.join(home, ".claude", "skills", "deploy");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(dir);
    expect(report).toEqual([{ slug: SKILL, hash: folderHash(PROSE_SKILL.files), status: "installed" }]);
    expect(out.conflicts).toBe(0);
    expect(convergenceState().applied).toBe(revision);
    expect(fs.existsSync(path.join(home, ".codecast", "capabilities", "store", folderHash(PROSE_SKILL.files)))).toBe(true);

    // Steady state: the next pass writes nothing.
    const again = await pass(home, server);
    expect(again.out.wrote).toBe(0);
  });

  test("a skill shipping scripts waits for this device's consent, then installs", async () => {
    const home = tmpHome();
    const server = fakeServer();
    const v: KitVersion = { kind: "skill", name: "deploy", surfaces: ["prose", "ships_scripts"], files: [f("SKILL.md", "Run scripts/go.sh\n"), f("scripts/go.sh", "#!/bin/sh\necho go\n", true)] };
    server.state.bindings.set(SKILL, true);
    server.state.versions.set(SKILL, v);

    const first = await pass(home, server);
    expect(fs.existsSync(path.join(home, ".agents", "skills", "deploy"))).toBe(false);
    expect(first.report).toEqual([{ slug: SKILL, hash: folderHash(v.files), status: "pending_consent", detail: "prose,ships_scripts" }]);

    server.state.consents.push({ capability_slug: SKILL, manifest_hash: "some-other-hash" });
    await pass(home, server);
    expect(fs.existsSync(path.join(home, ".agents", "skills", "deploy"))).toBe(false);

    server.state.consents.push({ capability_slug: SKILL, manifest_hash: folderHash(v.files) });
    const third = await pass(home, server);
    const script = path.join(home, ".agents", "skills", "deploy", "scripts", "go.sh");
    expect(fs.readFileSync(script, "utf-8")).toContain("echo go");
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);
    expect(third.report[0]!.status).toBe("installed");
  });

  test("off removes exactly the files the driver wrote, and nothing beside them", async () => {
    const home = tmpHome();
    const server = fakeServer();
    // The person's own skills, in both directories the kit writes into.
    fs.mkdirSync(path.join(home, ".agents", "skills", "mine"), { recursive: true });
    fs.writeFileSync(path.join(home, ".agents", "skills", "mine", "SKILL.md"), "mine\n");
    fs.mkdirSync(path.join(home, ".claude", "skills", "handmade"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "skills", "handmade", "SKILL.md"), "handmade\n");
    server.state.bindings.set(SKILL, true);
    server.state.versions.set(SKILL, PROSE_SKILL);
    await pass(home, server);
    const written = JSON.parse(fs.readFileSync(kitLedgerPath(home), "utf-8")).files[SKILL];
    expect(written).toHaveLength(3);

    server.state.bindings.set(SKILL, false);
    const off = await pass(home, server);
    for (const p of written) expect(fs.existsSync(p)).toBe(false);
    expect(fs.existsSync(path.join(home, ".agents", "skills", "deploy"))).toBe(false);
    expect(fs.readFileSync(path.join(home, ".agents", "skills", "mine", "SKILL.md"), "utf-8")).toBe("mine\n");
    expect(fs.readFileSync(path.join(home, ".claude", "skills", "handmade", "SKILL.md"), "utf-8")).toBe("handmade\n");
    expect(JSON.parse(fs.readFileSync(kitLedgerPath(home), "utf-8")).files[SKILL]).toBeUndefined();
    expect(off.report).toEqual([]);
  });

  test("a name that collides with a file the driver did not write is a conflict, never an overwrite", async () => {
    const home = tmpHome();
    const server = fakeServer();
    const cmd = path.join(home, ".claude", "commands", "review.md");
    fs.mkdirSync(path.dirname(cmd), { recursive: true });
    fs.writeFileSync(cmd, "my own review command\n");
    const slug = "authored/t1/command/review";
    server.state.bindings.set(slug, true);
    server.state.versions.set(slug, { kind: "command", name: "review", surfaces: ["prose"], files: [f("review.md", "The team's review.\n")] });

    const { out, report } = await pass(home, server);
    expect(fs.readFileSync(cmd, "utf-8")).toBe("my own review command\n");
    expect(out.conflicts).toBe(1);
    expect(report[0]).toMatchObject({ slug, status: "conflict" });
    expect(report[0]!.detail).toContain("did not write it");
    expect(convergenceState().applied).toBeLessThan(revision);

    // Turning it off must not delete the person's file either.
    server.state.bindings.set(slug, false);
    await pass(home, server);
    expect(fs.readFileSync(cmd, "utf-8")).toBe("my own review command\n");
  });

  test("a skill directory someone else made is a conflict even when no file name collides", async () => {
    const home = tmpHome();
    const server = fakeServer();
    fs.mkdirSync(path.join(home, ".agents", "skills", "deploy"), { recursive: true });
    fs.writeFileSync(path.join(home, ".agents", "skills", "deploy", "OTHER.md"), "theirs\n");
    server.state.bindings.set(SKILL, true);
    server.state.versions.set(SKILL, PROSE_SKILL);
    const { report } = await pass(home, server);
    expect(report[0]!.status).toBe("conflict");
    expect(fs.existsSync(path.join(home, ".agents", "skills", "deploy", "SKILL.md"))).toBe(false);
  });

  test("commands land in ~/.claude/commands and subagents in ~/.claude/agents", async () => {
    const home = tmpHome();
    const server = fakeServer();
    server.state.bindings.set("authored/t1/command/ship", true);
    server.state.versions.set("authored/t1/command/ship", { kind: "command", name: "ship", surfaces: ["prose"], files: [f("ship.md", "Ship it.\n")] });
    server.state.bindings.set("authored/u1/subagent/critic", true);
    server.state.versions.set("authored/u1/subagent/critic", { kind: "subagent", name: "critic", surfaces: ["prose"], workspace: "user:u1", files: [f("critic.md", "---\nname: critic\n---\nYou critique.\n")] });
    await pass(home, server);
    expect(fs.readFileSync(path.join(home, ".claude", "commands", "ship.md"), "utf-8")).toBe("Ship it.\n");
    expect(fs.readFileSync(path.join(home, ".claude", "agents", "critic.md"), "utf-8")).toContain("You critique.");
  });

  test("a new version replaces the old files and drops the ones it no longer ships", async () => {
    const home = tmpHome();
    const server = fakeServer();
    server.state.bindings.set(SKILL, true);
    server.state.versions.set(SKILL, PROSE_SKILL);
    await pass(home, server);
    server.state.versions.set(SKILL, { ...PROSE_SKILL, files: [f("SKILL.md", "Deploy v2.\n")] });
    await pass(home, server);
    const dir = path.join(home, ".agents", "skills", "deploy");
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toBe("Deploy v2.\n");
    expect(fs.existsSync(path.join(dir, "reference"))).toBe(false);
  });

  test("a server that cannot answer keeps the install and the machine behind", async () => {
    const home = tmpHome();
    const server = fakeServer();
    server.state.bindings.set(SKILL, true);
    server.state.versions.set(SKILL, PROSE_SKILL);
    await pass(home, server);
    server.state.versionDown = true;
    const { report } = await pass(home, server);
    expect(fs.existsSync(path.join(home, ".agents", "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(report[0]).toMatchObject({ slug: SKILL, status: "error" });
    expect(convergenceState().applied).toBeLessThan(revision);
  });

  test("an archive that does not match its hash is never installed", async () => {
    const home = tmpHome();
    const server = fakeServer();
    server.state.bindings.set(SKILL, true);
    server.state.versions.set(SKILL, { ...PROSE_SKILL, archive: packArchive([f("SKILL.md", "something else\n")]) });
    const { report } = await pass(home, server);
    expect(fs.existsSync(path.join(home, ".agents", "skills", "deploy"))).toBe(false);
    expect(report[0]).toMatchObject({ status: "error" });
    expect(report[0]!.detail).toContain("hash_mismatch");
  });

  test("a PNG round-trips byte-identical through publish, store and install", async () => {
    const image = png();
    // Not text: a UTF-8 decode would replace the 0x89 signature byte and more.
    expect(Buffer.from(image.toString("utf-8"), "utf-8").equals(image)).toBe(false);

    // Publish from one machine, capturing the archive the server would store.
    const publisher = tmpHome();
    const src = path.join(publisher, ".claude", "skills", "brand");
    fs.mkdirSync(path.join(src, "assets"), { recursive: true });
    fs.writeFileSync(path.join(src, "SKILL.md"), "---\nname: brand\n---\nUse assets/logo.png.\n");
    fs.writeFileSync(path.join(src, "assets", "logo.png"), image);
    let archive: Buffer | undefined;
    let published: any;
    await publishKitPackage(locateKitItem(publisher, "brand"), {
      home: publisher,
      workspace: { kind: "team", teamId: "t1" },
      deviceId: "pub",
      post: async (route, body) => {
        if (route.endsWith("/upload-url")) return { upload_url: "https://upload.test/x" };
        published = body;
        return { status: "created", version: 1 };
      },
      fetchImpl: (async (_u: string, init: any) => {
        archive = Buffer.from(init.body);
        return new Response(JSON.stringify({ storageId: "st" }));
      }) as unknown as typeof fetch,
    });
    expect(published.files).toContainEqual({ path: "assets/logo.png", size: image.length, executable: false });

    // Install on another machine from exactly that archive.
    const home = tmpHome();
    const server = fakeServer();
    const slug = "authored/t1/skill/brand";
    server.state.bindings.set(slug, true);
    server.state.versions.set(slug, { kind: "skill", name: "brand", surfaces: ["prose"], files: [f("SKILL.md", "---\nname: brand\n---\nUse assets/logo.png.\n"), { path: "assets/logo.png", bytes: image, executable: false }], archive });
    expect(folderHash(server.state.versions.get(slug)!.files)).toBe(published.folder_hash);

    const { report } = await pass(home, server);
    expect(report[0]).toMatchObject({ slug, status: "installed" });
    const stored = fs.readFileSync(path.join(home, ".codecast", "capabilities", "store", published.folder_hash, "assets", "logo.png"));
    expect(stored.equals(image)).toBe(true);
    const installed = fs.readFileSync(path.join(home, ".agents", "skills", "brand", "assets", "logo.png"));
    expect(installed.equals(image)).toBe(true);

    // Byte comparison holds the steady state: nothing is rewritten.
    const again = await pass(home, server);
    expect(again.out.wrote).toBe(0);
  });

  describe("Use the kit's copy", () => {
    /** Every file under `dir` as path -> bytes, for byte-identical checks. */
    const snapshot = (dir: string): Record<string, string> => {
      const out: Record<string, string> = {};
      const walk = (d: string, rel: string) => {
        for (const n of fs.readdirSync(d).sort()) {
          const abs = path.join(d, n);
          if (fs.statSync(abs).isDirectory()) walk(abs, `${rel}${n}/`);
          else out[`${rel}${n}`] = fs.readFileSync(abs).toString("base64");
        }
      };
      walk(dir, "");
      return out;
    };
    const handMade = (home: string) => {
      const dir = path.join(home, ".claude", "skills", "deploy");
      fs.mkdirSync(path.join(dir, "img"), { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: deploy\n---\nMy own deploy.\n");
      fs.writeFileSync(path.join(dir, "img", "x.bin"), png());
      return dir;
    };

    test("without an adoption a conflict stays a conflict and nothing moves or is written", async () => {
      const home = tmpHome();
      const dir = handMade(home);
      const before = snapshot(dir);
      const server = fakeServer();
      server.state.bindings.set(SKILL, true);
      server.state.versions.set(SKILL, PROSE_SKILL);
      // An adoption pressed on some other version does not count for this one.
      server.state.adoptions.push({ slug: SKILL, hash: "f".repeat(64) });
      const { report } = await pass(home, server);
      expect(report[0]).toMatchObject({ slug: SKILL, status: "conflict" });
      expect(snapshot(dir)).toEqual(before);
      expect(fs.readdirSync(path.dirname(dir))).toEqual(["deploy"]);
      expect(fs.existsSync(path.join(home, ".agents", "skills", "deploy"))).toBe(false);
      expect(fs.existsSync(kitLedgerPath(home))).toBe(false);
    });

    test("an adopted conflict moves the original aside byte-identical, then installs and records it", async () => {
      const home = tmpHome();
      const dir = handMade(home);
      const before = snapshot(dir);
      const server = fakeServer();
      server.state.bindings.set(SKILL, true);
      server.state.versions.set(SKILL, PROSE_SKILL);
      server.state.adoptions.push({ slug: SKILL, hash: folderHash(PROSE_SKILL.files) });

      const { out, report } = await pass(home, server);
      // Out of every skills dir, so no client loads the old copy as a second skill.
      const asideRoot = path.join(home, ".codecast", "capabilities", "aside");
      const aside = fs.readdirSync(asideRoot).find((n) => /^deploy\.mine-\d{12}$/.test(n));
      expect(aside).toBeDefined();
      expect(snapshot(path.join(asideRoot, aside!))).toEqual(before);
      expect(fs.readdirSync(path.dirname(dir))).toEqual(["deploy"]);
      expect(fs.readdirSync(path.join(home, ".agents", "skills"))).toEqual(["deploy"]);
      expect(fs.lstatSync(dir).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8")).toContain("Deploy carefully.");
      expect(out.conflicts).toBe(0);
      expect(report[0]).toEqual({ slug: SKILL, hash: folderHash(PROSE_SKILL.files), status: "installed", detail: `moved your copy to ~/.codecast/capabilities/aside/${aside}` });
      expect(JSON.parse(fs.readFileSync(kitLedgerPath(home), "utf-8")).files[SKILL]).toContain(dir);
      expect(convergenceState().applied).toBe(revision);

      // Steady afterwards, and turning it off removes ours and keeps theirs.
      expect((await pass(home, server)).out.wrote).toBe(0);
      server.state.bindings.set(SKILL, false);
      await pass(home, server);
      expect(fs.existsSync(dir)).toBe(false);
      expect(snapshot(path.join(asideRoot, aside!))).toEqual(before);
    });

    test("hand-made skills of one name in both skills dirs move to two distinct aside paths", async () => {
      const home = tmpHome();
      const claudeCopy = handMade(home);
      const shared = path.join(home, ".agents", "skills", "deploy");
      fs.mkdirSync(shared, { recursive: true });
      fs.writeFileSync(path.join(shared, "SKILL.md"), "shared copy\n");
      const server = fakeServer();
      server.state.bindings.set(SKILL, true);
      server.state.versions.set(SKILL, PROSE_SKILL);
      server.state.adoptions.push({ slug: SKILL, hash: folderHash(PROSE_SKILL.files) });
      const { report } = await pass(home, server);
      const asideRoot = path.join(home, ".codecast", "capabilities", "aside");
      const moved = fs.readdirSync(asideRoot).sort();
      expect(moved).toHaveLength(2);
      const texts = moved.map((n) => fs.readFileSync(path.join(asideRoot, n, "SKILL.md"), "utf-8")).sort();
      expect(texts).toEqual(["---\nname: deploy\n---\nMy own deploy.\n", "shared copy\n"].sort());
      expect(fs.realpathSync(claudeCopy)).toBe(fs.realpathSync(shared));
      expect(report[0]!.status).toBe("installed");
      expect(report[0]!.detail).toContain(moved[0]);
      expect(report[0]!.detail).toContain(moved[1]);
    });

    test("an adopted command file is renamed beside itself, not deleted", async () => {
      const home = tmpHome();
      const cmd = path.join(home, ".claude", "commands", "review.md");
      fs.mkdirSync(path.dirname(cmd), { recursive: true });
      fs.writeFileSync(cmd, "my own review command\n");
      const slug = "authored/t1/command/review";
      const v: KitVersion = { kind: "command", name: "review", surfaces: ["prose"], files: [f("review.md", "The team's review.\n")] };
      const server = fakeServer();
      server.state.bindings.set(slug, true);
      server.state.versions.set(slug, v);
      server.state.adoptions.push({ slug, hash: folderHash(v.files) });
      await pass(home, server);
      expect(fs.readFileSync(cmd, "utf-8")).toBe("The team's review.\n");
      const aside = fs.readdirSync(path.dirname(cmd)).find((n) => n.startsWith("review.md.mine-"))!;
      expect(fs.readFileSync(path.join(path.dirname(cmd), aside), "utf-8")).toBe("my own review command\n");
    });
  });
});
