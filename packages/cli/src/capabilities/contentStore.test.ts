import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import {
  fetchIntoStore,
  folderHash,
  packArchive,
  readStored,
  readTree,
  storeDir,
  storeRoot,
  unpackArchive,
  type StoreFile,
} from "./contentStore.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cc-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const file = (p: string, text: string, executable = false): StoreFile => ({ path: p, bytes: Buffer.from(text), executable });

const SKILL = [
  file("SKILL.md", "---\nname: deploy\n---\nRun the deploy.\n"),
  file("scripts/run.sh", "#!/bin/sh\necho hi\n", true),
];

function serve(archive: Buffer, onFetch?: () => void): typeof fetch {
  return (async () => {
    onFetch?.();
    return new Response(new Uint8Array(archive));
  }) as unknown as typeof fetch;
}

describe("folder_hash", () => {
  test("folder_hash of the same tree matches on LF and CRLF checkouts", () => {
    const crlf = SKILL.map((f) => ({ ...f, bytes: Buffer.from(f.bytes.toString().replace(/\n/g, "\r\n")) }));
    expect(folderHash(crlf)).toBe(folderHash(SKILL));
  });

  test("order of files does not matter, content and the executable bit do", () => {
    expect(folderHash([...SKILL].reverse())).toBe(folderHash(SKILL));
    expect(folderHash([SKILL[0]!, { ...SKILL[1]!, executable: false }])).not.toBe(folderHash(SKILL));
    expect(folderHash([SKILL[0]!, file("scripts/run.sh", "#!/bin/sh\necho bye\n", true)])).not.toBe(folderHash(SKILL));
  });

  test("binary files are hashed raw: a CR LF pair inside one is content", () => {
    const bin = (s: string) => ({ path: "a.bin", bytes: Buffer.from(`\0${s}`), executable: false });
    expect(folderHash([bin("x\r\ny")])).not.toBe(folderHash([bin("x\ny")]));
  });

  test("the hash of a tree read from disk equals the hash of its archive", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL[0]!.bytes);
    fs.writeFileSync(path.join(dir, "scripts", "run.sh"), SKILL[1]!.bytes, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, ".DS_Store"), "junk");
    const tree = readTree(dir);
    expect(tree.map((f) => f.path).sort()).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(folderHash(unpackArchive(packArchive(tree)))).toBe(folderHash(SKILL));
  });
});

describe("the archive", () => {
  test("round trips paths, bytes and the executable bit, and is deterministic", () => {
    const a = packArchive(SKILL);
    expect(packArchive([...SKILL].reverse()).equals(a)).toBe(true);
    const back = unpackArchive(a);
    expect(back.map((f) => [f.path, f.bytes.toString(), f.executable])).toEqual(
      SKILL.map((f) => [f.path, f.bytes.toString(), f.executable]),
    );
  });

  test("an entry that climbs out of the item is refused", () => {
    const good = zlib.gunzipSync(packArchive([file("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "x")]));
    good.write("../../.ssh/authorized_keys\0\0\0\0", 0, "utf-8");
    expect(() => unpackArchive(zlib.gzipSync(good))).toThrow(/unsafe path/);
  });
});

describe("fetchIntoStore", () => {
  test("an archive whose sha differs from the pin is never extracted", async () => {
    const home = tmp();
    const wrong = "0".repeat(64);
    const r = await fetchIntoStore({ home, hash: wrong, url: "https://x/a", fetchImpl: serve(packArchive(SKILL)) });
    expect(r).toMatchObject({ ok: false, reason: "hash_mismatch" });
    expect(fs.existsSync(storeDir(home, wrong))).toBe(false);
    const leftovers = fs.existsSync(storeRoot(home)) ? fs.readdirSync(storeRoot(home)) : [];
    expect(leftovers.filter((n) => !n.endsWith(".lock"))).toEqual([]);
  });

  test("a verified archive lands under its hash and the next call never fetches", async () => {
    const home = tmp();
    const hash = folderHash(SKILL);
    let fetches = 0;
    const f = serve(packArchive(SKILL), () => fetches++);
    const first = await fetchIntoStore({ home, hash, url: "https://x/a", fetchImpl: f });
    expect(first).toMatchObject({ ok: true, fetched: true });
    expect(fs.statSync(path.join(storeDir(home, hash), "scripts", "run.sh")).mode & 0o111).not.toBe(0);
    const second = await fetchIntoStore({ home, hash, url: "https://x/a", fetchImpl: f });
    expect(second).toMatchObject({ ok: true, fetched: false });
    expect(fetches).toBe(1);
  });

  test("a stored tree edited in place reads as absent and is refetched", async () => {
    const home = tmp();
    const hash = folderHash(SKILL);
    await fetchIntoStore({ home, hash, url: "https://x/a", fetchImpl: serve(packArchive(SKILL)) });
    fs.writeFileSync(path.join(storeDir(home, hash), "SKILL.md"), "tampered");
    expect(readStored(home, hash)).toBeNull();
  });

  test("the lock is never held across the fetch", async () => {
    const home = tmp();
    const lockFile = path.join(storeRoot(home), ".codecast-capability.lock");
    fs.mkdirSync(storeRoot(home), { recursive: true });
    let heldDuringFetch: boolean | undefined;
    const r = await fetchIntoStore({
      home,
      hash: folderHash(SKILL),
      url: "https://x/a",
      fetchImpl: serve(packArchive(SKILL), () => {
        heldDuringFetch = fs.existsSync(lockFile);
      }),
    });
    expect(r.ok).toBe(true);
    expect(heldDuringFetch).toBe(false);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  test("a failed fetch reports and writes nothing", async () => {
    const home = tmp();
    const f = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const r = await fetchIntoStore({ home, hash: folderHash(SKILL), url: "https://x/a", fetchImpl: f });
    expect(r).toMatchObject({ ok: false, reason: "fetch_failed" });
    expect(fs.existsSync(storeDir(home, folderHash(SKILL)))).toBe(false);
  });
});
