import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  VaultMirror,
  buildMirrorNote,
  diffScanAgainstLedger,
  type MirrorLedgerEntry,
  type VaultMirrorTransport,
} from "./vaultMirror.js";
import { addVault, setVaultMirroring } from "./vaultRegistry.js";
import { scanVault, vaultContentHash } from "./vaultScope.js";
import type { VaultFileEntry, VaultMirrorUpsertRequest } from "@codecast/shared/contracts";

let base = "";
let configDir = "";
let notesDir = "";

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mirror-"));
  configDir = path.join(base, ".codecast");
  notesDir = path.join(base, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
});

function write(rel: string, content: string): void {
  const abs = path.join(notesDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function file(p: string, mtime: number, size: number): VaultFileEntry {
  return { path: p, mtime, size };
}

/** Records every push instead of making one, and answers the way the server
 *  would: the sweep finishes on the first call unless a test says otherwise. */
function recordingTransport(opts: { sweepPages?: number } = {}) {
  const pushes: VaultMirrorUpsertRequest[] = [];
  const registers: Record<string, unknown>[] = [];
  const uploads: Buffer[] = [];
  let sweepsLeft = opts.sweepPages ?? 0;
  const transport: VaultMirrorTransport = {
    async register(body) {
      registers.push(body);
      return { ok: true };
    },
    async upsert(body) {
      pushes.push(JSON.parse(JSON.stringify(body)));
      const unfinished = body.complete === true && sweepsLeft > 0;
      if (unfinished) sweepsLeft--;
      return {
        upserted: body.notes.length,
        deleted: 0,
        sweep_complete: !unfinished,
        sweep_after_path: unfinished ? `cursor-${sweepsLeft}` : null,
        note_count: body.note_count ?? 0,
      };
    },
    async uploadBody(data) {
      uploads.push(data);
      return `storage-${uploads.length}`;
    },
  };
  return { transport, pushes, registers, uploads };
}

function mirrorFor(transport: VaultMirrorTransport): VaultMirror {
  return new VaultMirror({ configDir, deviceId: "dev-1", transport, batchIntervalMs: 0 });
}

describe("diffScanAgainstLedger", () => {
  test("splits a scan into changed, unchanged and removed", () => {
    const ledger: MirrorLedgerEntry = {
      last_scan_at: 1,
      files: {
        "same.md": { m: 10, s: 100, h: "aaa" },
        "edited.md": { m: 10, s: 100, h: "bbb" },
        "gone.md": { m: 10, s: 100, h: "ccc" },
      },
    };
    const result = diffScanAgainstLedger(
      [file("same.md", 10, 100), file("edited.md", 20, 140), file("new.md", 30, 10)],
      ledger,
    );
    expect(result.unchanged).toEqual(["same.md"]);
    expect(result.changed.map((f) => f.path)).toEqual(["edited.md", "new.md"]);
    expect(result.removed).toEqual(["gone.md"]);
  });

  test("everything is changed when there is no ledger", () => {
    const result = diffScanAgainstLedger([file("a.md", 1, 2), file("b.md", 1, 2)], undefined);
    expect(result.changed).toHaveLength(2);
    expect(result.unchanged).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  test("a file still owed a body counts as changed however quiet it is", () => {
    const ledger: MirrorLedgerEntry = {
      last_scan_at: 1,
      files: { "owed.md": { m: 10, s: 100, h: "aaa", p: true } },
    };
    const result = diffScanAgainstLedger([file("owed.md", 10, 100)], ledger);
    expect(result.changed.map((f) => f.path)).toEqual(["owed.md"]);
    expect(result.unchanged).toEqual([]);
  });
});

describe("buildMirrorNote", () => {
  test("content_hash is the SAME digest the loopback route serves as its ETag", () => {
    const data = Buffer.from("# Title\n\nbody\n");
    const note = buildMirrorNote("a.md", file("a.md", 1, data.length), data);
    expect(note.content_hash).toBe(vaultContentHash(data));
    expect(note.content_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("title comes from frontmatter, then H1, then the basename", () => {
    const fm = Buffer.from("---\ntitle: From Frontmatter\n---\n\n# Heading\n");
    expect(buildMirrorNote("a.md", file("a.md", 1, fm.length), fm).title).toBe("From Frontmatter");

    const h1 = Buffer.from("# From Heading\n\ntext\n");
    expect(buildMirrorNote("a.md", file("a.md", 1, h1.length), h1).title).toBe("From Heading");

    const bare = Buffer.from("just text\n");
    expect(buildMirrorNote("notes/Some Note.md", file("x", 1, bare.length), bare).title).toBe("Some Note");
  });

  test("merges frontmatter and inline tags, dedupes links, counts headings", () => {
    const data = Buffer.from(
      "---\ntags: [alpha, beta]\n---\n\n# One\n\n#beta #gamma\n\n[[Target]] and [[Target#Section]] and [[Other|alias]]\n\n## Two\n",
    );
    const note = buildMirrorNote("a.md", file("a.md", 1, data.length), data);
    expect([...note.tags].sort()).toEqual(["alpha", "beta", "gamma"]);
    expect([...note.links].sort()).toEqual(["Other", "Target"]);
    expect(note.heading_count).toBe(2);
  });

  test("an attachment gets no note metadata", () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const note = buildMirrorNote("img/pic.png", file("img/pic.png", 1, 4), data);
    expect(note.title).toBe("pic.png");
    expect(note.tags).toEqual([]);
    expect(note.links).toEqual([]);
    expect(note.content_hash).toBe(vaultContentHash(data));
  });
});

describe("VaultMirror push cycle", () => {
  function registerMirrored(): void {
    addVault(configDir, notesDir, "Notes");
    setVaultMirroring(configDir, notesDir, true);
  }

  test("a vault that never opted in is never pushed", async () => {
    addVault(configDir, notesDir, "Notes");
    write("a.md", "# A\n");
    const { transport, pushes, registers } = recordingTransport();
    await mirrorFor(transport).syncAll();
    expect(pushes).toEqual([]);
    expect(registers).toEqual([]);
  });

  test("first full scan pushes every note and declares itself complete", async () => {
    registerMirrored();
    write("a.md", "# A\n\n[[B]]\n");
    write("b.md", "# B\n");
    const { transport, pushes, uploads } = recordingTransport();
    await mirrorFor(transport).syncAll();

    const withNotes = pushes.filter((p) => p.notes.length > 0);
    const paths = withNotes.flatMap((p) => p.notes.map((n) => n.path)).sort();
    expect(paths).toEqual(["a.md", "b.md"]);
    // Every batch of one scan shares its stamp, and the last one declares it.
    const scanIds = new Set(pushes.map((p) => p.scan_id));
    expect(scanIds.size).toBe(1);
    const final = pushes[pushes.length - 1];
    expect(final.complete).toBe(true);
    expect(final.note_count).toBe(2);
    // Small bodies ride file storage, and the row points at the blob.
    expect(uploads).toHaveLength(2);
    expect(withNotes[0].notes[0].body_storage_id).toMatch(/^storage-/);
  });

  test("a second scan with nothing changed sends bare paths, not metadata", async () => {
    registerMirrored();
    write("a.md", "# A\n");
    const { transport, pushes } = recordingTransport();
    const mirror = mirrorFor(transport);
    await mirror.syncAll();
    pushes.length = 0;

    await mirror.syncAll();
    expect(pushes.flatMap((p) => p.notes)).toEqual([]);
    expect(pushes.flatMap((p) => p.stamp_paths ?? [])).toEqual(["a.md"]);
  });

  test("an edited note is re-read and re-pushed with a new hash", async () => {
    registerMirrored();
    write("a.md", "# A\n");
    const { transport, pushes } = recordingTransport();
    const mirror = mirrorFor(transport);
    await mirror.syncAll();
    const firstHash = pushes.flatMap((p) => p.notes)[0].content_hash;
    pushes.length = 0;

    // A distinct size guarantees the scan sees a change even if mtime rounds
    // to the same millisecond on a fast filesystem.
    write("a.md", "# A changed substantially\n");
    await mirror.syncAll();
    const pushed = pushes.flatMap((p) => p.notes);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].path).toBe("a.md");
    expect(pushed[0].content_hash).not.toBe(firstHash);
    expect(pushes.flatMap((p) => p.stamp_paths ?? [])).toEqual([]);
  });

  test("a deleted note is reported as a targeted delete", async () => {
    registerMirrored();
    write("a.md", "# A\n");
    write("b.md", "# B\n");
    const { transport, pushes } = recordingTransport();
    const mirror = mirrorFor(transport);
    await mirror.syncAll();
    pushes.length = 0;

    fs.unlinkSync(path.join(notesDir, "b.md"));
    await mirror.syncAll();
    expect(pushes.flatMap((p) => p.deleted_paths ?? [])).toEqual(["b.md"]);
  });

  test("a budgeted sweep is driven to the end before the cycle finishes", async () => {
    registerMirrored();
    write("a.md", "# A\n");
    const { transport, pushes } = recordingTransport({ sweepPages: 2 });
    await mirrorFor(transport).syncAll();

    const completions = pushes.filter((p) => p.complete === true);
    expect(completions).toHaveLength(3);
    // The first completion starts at the beginning; each later one resumes from
    // the cursor the server handed back.
    expect(completions[0].sweep_after_path).toBeUndefined();
    expect(completions[1].sweep_after_path).toBe("cursor-1");
    expect(completions[2].sweep_after_path).toBe("cursor-0");
  });

  test("batches stay under the note-count bound", async () => {
    registerMirrored();
    for (let i = 0; i < 250; i++) write(`n${String(i).padStart(3, "0")}.md`, `# Note ${i}\n`);
    const { transport, pushes } = recordingTransport();
    await mirrorFor(transport).syncAll();

    const noteBatches = pushes.filter((p) => p.notes.length > 0);
    expect(noteBatches.length).toBeGreaterThan(1);
    for (const batch of noteBatches) expect(batch.notes.length).toBeLessThanOrEqual(200);
    expect(noteBatches.flatMap((p) => p.notes)).toHaveLength(250);
  });

  test("turning mirroring off tears the remote copy down on the next cycle", async () => {
    registerMirrored();
    write("a.md", "# A\n");
    const { transport, registers } = recordingTransport();
    const mirror = mirrorFor(transport);
    await mirror.syncAll();
    registers.length = 0;

    setVaultMirroring(configDir, notesDir, false);
    await mirror.syncAll();
    expect(registers).toHaveLength(1);
    expect(registers[0].enabled).toBe(false);

    // And the teardown happens once: the watermark is forgotten with it.
    registers.length = 0;
    await mirror.syncAll();
    expect(registers).toEqual([]);
  });

  test("a vault mirrored after boot still gets watched", async () => {
    addVault(configDir, notesDir, "Notes");
    write("a.md", "# A\n");
    const { transport } = recordingTransport();
    const subscribed: string[] = [];
    const unsubscribed: string[] = [];
    const mirror = new VaultMirror({
      configDir,
      deviceId: "dev-1",
      transport,
      batchIntervalMs: 0,
      watch: (vault) => {
        subscribed.push(vault.id);
        return () => unsubscribed.push(vault.id);
      },
    });

    // Mirroring is off, so nothing is watched.
    await mirror.syncAll();
    expect(subscribed).toEqual([]);

    // `cast vault mirror --on` only edits config.json — the daemon has to
    // notice on its own.
    setVaultMirroring(configDir, notesDir, true);
    await mirror.syncAll();
    expect(subscribed).toHaveLength(1);

    // And a second cycle does not stack a duplicate subscription.
    await mirror.syncAll();
    expect(subscribed).toHaveLength(1);

    setVaultMirroring(configDir, notesDir, false);
    await mirror.syncAll();
    expect(unsubscribed).toHaveLength(1);
  });

  test("the scan the mirror pushes is the scan the loopback routes serve", async () => {
    registerMirrored();
    write("a.md", "# A\n");
    write(".obsidian/workspace.json", "{}");
    write("secrets.env", "TOKEN=1");
    const { transport, pushes } = recordingTransport();
    await mirrorFor(transport).syncAll();

    const pushed = pushes.flatMap((p) => p.notes.map((n) => n.path)).sort();
    const served = (await scanVault(notesDir)).map((f) => f.path).sort();
    expect(pushed).toEqual(served);
    expect(pushed).not.toContain("secrets.env");
  });
});
