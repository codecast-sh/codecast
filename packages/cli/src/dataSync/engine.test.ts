import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncOnce, type CommitChange, type DataSyncApi, type RemoteRow } from "./engine.js";

const FOLDER = ".local/share/tool/freezes";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** The index in memory, holding what convex/dataSync.ts holds: one row per file, a seq per change, bytes by storage id. */
function fakeServer() {
  const rows = new Map<string, RemoteRow>();
  const blobs = new Map<string, Buffer>();
  let seq = 0;
  let ids = 0;
  const forDevice = (device: string): DataSyncApi => ({
    async declareFolders() {},
    async folders() { return [{ path: FOLDER, declared_by: "tool", bytes: 0, files: 0 }]; },
    async changes(since) {
      const all = [...rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
      return { rows: all.slice(0, 2).map((r) => structuredClone(r)), more: all.length > 2 };
    },
    async knownContents(shas) { return shas.filter((s) => [...rows.values()].some((r) => r.sha256 === s && r.url)); },
    async upload(bytes) { const id = `s${++ids}`; blobs.set(id, Buffer.from(bytes)); return id; },
    async commit(changes: CommitChange[]) {
      const seqs = changes.map((c) => {
        const blob = c.deleted ? null : c.storage_id ?? [...rows.values()].find((r) => r.sha256 === c.sha256 && r.url)?.url;
        if (!c.deleted && !blob) throw new Error("no content");
        if (c.storage_id && sha(blobs.get(c.storage_id)!) !== c.sha256) throw new Error("mismatch");
        rows.set(`${c.folder}/${c.rel}`, { folder: c.folder, rel: c.rel, sha256: c.sha256, size: c.size, mtime: c.mtime, deleted: c.deleted, seq: ++seq, device_id: device, url: blob ?? null });
        return seq;
      });
      return { seqs };
    },
    async download(url) { return blobs.get(url)!; },
  });
  return { forDevice, rows };
}

function machine(server: ReturnType<typeof fakeServer>, name: string, clock: { t: number }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `data-${name}-`));
  const stateDir = path.join(home, ".codecast", "data-sync");
  const file = (rel: string) => path.join(home, FOLDER, rel);
  return {
    home,
    stateDir,
    sync: () => syncOnce({ home, stateDir, api: server.forDevice(name), now: () => clock.t }),
    write(rel: string, text: string, at = clock.t - 10_000) {
      fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
      fs.writeFileSync(file(rel), text);
      fs.utimesSync(file(rel), new Date(at), new Date(at));
    },
    read: (rel: string) => (fs.existsSync(file(rel)) ? fs.readFileSync(file(rel), "utf8") : null),
    rm: (rel: string) => fs.rmSync(file(rel)),
  };
}

describe("data sync between machines", () => {
  test("files made on one machine reach the other, in nested folders and across pages", async () => {
    const server = fakeServer();
    const clock = { t: Date.now() };
    const laptop = machine(server, "laptop", clock);
    const host = machine(server, "host", clock);
    laptop.write("a.json", "{\"a\":1}");
    laptop.write("suggest/b.json", "b");
    laptop.write("suggest/c.json", "c");
    expect((await laptop.sync()).pushed).toBe(3);
    const r = await host.sync();
    expect(r.pulled).toBe(3);
    expect([host.read("a.json"), host.read("suggest/b.json"), host.read("suggest/c.json")]).toEqual(["{\"a\":1}", "b", "c"]);
    // Nothing changed: a pass sends and takes nothing.
    expect(await host.sync()).toMatchObject({ pushed: 0, pulled: 0 });
    expect(await laptop.sync()).toMatchObject({ pushed: 0, pulled: 0 });
  });

  test("an edit and a deletion travel both ways, and identical content is sent once", async () => {
    const server = fakeServer();
    const clock = { t: Date.now() };
    const laptop = machine(server, "laptop", clock);
    const host = machine(server, "host", clock);
    laptop.write("a", "one");
    await laptop.sync();
    await host.sync();
    host.write("a", "two");
    host.write("copy", "two");
    await host.sync();
    await laptop.sync();
    expect([laptop.read("a"), laptop.read("copy")]).toEqual(["two", "two"]);
    laptop.rm("a");
    await laptop.sync();
    expect((await host.sync()).deletedHere).toBe(1);
    expect(host.read("a")).toBeNull();
    expect(server.rows.get(`${FOLDER}/a`)?.deleted).toBe(true);
  });

  test("a file both machines changed keeps the newer write, and the older one is set aside", async () => {
    const server = fakeServer();
    const clock = { t: Date.now() };
    const laptop = machine(server, "laptop", clock);
    const host = machine(server, "host", clock);
    laptop.write("f", "base");
    await laptop.sync();
    await host.sync();
    laptop.write("f", "laptop edit", clock.t - 9_000);
    host.write("f", "host edit, later", clock.t - 5_000);
    await laptop.sync();
    const r = await host.sync();
    expect(r.conflicts).toEqual([`${FOLDER}/f`]);
    await laptop.sync();
    expect([laptop.read("f"), host.read("f")]).toEqual(["host edit, later", "host edit, later"]);
    const aside = path.join(host.stateDir, "conflicts", FOLDER);
    expect(fs.readdirSync(aside).map((n) => fs.readFileSync(path.join(aside, n), "utf8"))).toEqual(["laptop edit"]);
  });

  test("a file still being written waits for the next pass", async () => {
    const server = fakeServer();
    const clock = { t: Date.now() };
    const laptop = machine(server, "laptop", clock);
    laptop.write("busy", "half", clock.t);
    laptop.write("x.json.123.tmp", "partial");
    expect((await laptop.sync()).pushed).toBe(0);
    clock.t += 5_000;
    expect((await laptop.sync()).pushed).toBe(1);
  });
});
