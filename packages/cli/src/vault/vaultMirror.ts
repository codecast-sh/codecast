// Pushes a vault's note metadata to the Convex mirror so the same vault can be
// READ from another device.
//
// This is a one-way projection and nothing local depends on it. The loopback
// bridge stays the primary channel, the disk stays canonical, and a vault whose
// mirror is off (the default) never touches the network here at all — the push
// loop skips it before it reads a single file.
//
// Shape of a cycle, and why:
//  - A FULL SCAN reuses vaultScope.scanVault, so the mirror can never see a
//    different file set than the routes serve or the watcher watches.
//  - Files whose mtime and size match the local ledger are not re-read. They
//    still have to be mentioned, because the server deletes rows an incomplete
//    scan never touched — but they go out as bare paths in `stamp_paths`
//    (~40 bytes each) instead of full metadata (~500), so a quiet vault's
//    periodic scan costs almost nothing.
//  - Changed files are read once: the same buffer feeds the content hash, the
//    parsed metadata, and (under the size gate) the body upload.
//  - Batches are bounded by serialized bytes with syncService's own chunker and
//    spaced by a fixed interval, because the failure mode this backend actually
//    has is saturation, not slowness.
//  - The ledger under ~/.codecast is a watermark, not a cache of truth: losing
//    it costs one redundant full push, never a wrong mirror.

import * as fsp from "fs/promises";
import * as path from "path";
import { CachedJsonStore } from "../cachedJsonStore.js";
import { chunkMessagesBySize } from "../syncService.js";
import { cliFetch } from "../cliHttp.js";
import { parseNote } from "@codecast/shared/vault";
import { listVaults } from "./vaultRegistry.js";
import {
  VAULT_MIRROR_MAX_BODY_BYTES,
  VAULT_MIRROR_MAX_STAMP_BATCH,
  isVaultMarkdownPath,
  type VaultFileEntry,
  type VaultInfo,
  type VaultMirrorNote,
  type VaultMirrorUpsertRequest,
  type VaultMirrorUpsertResponse,
} from "@codecast/shared/contracts";
import { resolveVaultPath, scanVault, vaultContentHash } from "./vaultScope.js";

/** Notes per push. Well under the server's 500 cap; the byte bound below is
 *  what actually decides most batches. */
const MAX_NOTES_PER_BATCH = 200;
/** Serialized bytes per push. Metadata is small, so this is far below the
 *  ~0.9MB the transcript sync allows — a mirror batch has no reason to be big,
 *  and small mutations are what a contended backend commits. */
const MAX_BATCH_BYTES = 400_000;
/** Gap between pushes. The mirror is background work: it must never be the
 *  reason a foreground write waits. */
const BATCH_INTERVAL_MS = 250;
/** How often a mirrored vault gets a full scan. The watcher covers the live
 *  case; this is the backstop that catches whatever happened while the daemon
 *  was not running. */
const FULL_SCAN_INTERVAL_MS = 30 * 60_000;
/** Watcher events coalesce for this long before an incremental push. Long
 *  enough that a save-heavy editing burst is one push, short enough that a
 *  remote reader sees the change while it still feels live. */
const EVENT_DEBOUNCE_MS = 3_000;
/** Body uploads started at once, and the ceiling per cycle. The first mirror of
 *  a large vault would otherwise fire thousands of uploads in a burst; the
 *  remainder simply lands on the next cycle. */
const UPLOAD_CONCURRENCY = 4;
const MAX_UPLOADS_PER_CYCLE = 200;
const REQUEST_TIMEOUT_MS = 30_000;
/** Age past which a ledger entry is dropped at load rather than reconciled. */
const LEDGER_MAX_AGE_MS = 90 * 24 * 60 * 60_000;

/** Per-file watermark. Keys are short because a big vault writes this whole
 *  object: m=mtime, s=size, h=content hash, u=body uploaded for that hash,
 *  p=a body is still owed for that hash (the cycle's upload budget ran out, or
 *  the upload failed). */
interface LedgerFile {
  m: number;
  s: number;
  h: string;
  u?: boolean;
  p?: boolean;
}

export interface MirrorLedgerEntry {
  last_scan_at: number;
  files: Record<string, LedgerFile>;
}

/** What the pusher needs from the network, isolated so the logic can be tested
 *  without a backend (and so a caller can point it at a different transport). */
export interface VaultMirrorTransport {
  register(body: Record<string, unknown>): Promise<any>;
  upsert(body: VaultMirrorUpsertRequest): Promise<VaultMirrorUpsertResponse>;
  /** Returns the storage id of the uploaded body, or null when the upload
   *  failed — a failed body upload must degrade to metadata-only, never to a
   *  failed sync. */
  uploadBody(data: Buffer): Promise<string | null>;
}

export interface VaultMirrorOptions {
  configDir: string;
  deviceId: string;
  transport: VaultMirrorTransport;
  /** Subscribe to a vault's file events, returning an unsubscribe. The daemon
   *  passes the watch hub the browser already uses, so a mirrored vault is
   *  watched once rather than twice. Omitted, the mirror still works — it just
   *  falls back to the periodic scan for freshness. */
  watch?: (vault: VaultInfo, onChange: () => void) => () => void;
  log?: (msg: string) => void;
  /** Tests shorten these; production uses the constants above. */
  fullScanIntervalMs?: number;
  eventDebounceMs?: number;
  batchIntervalMs?: number;
  now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** HTTP transport over the same /cli/* routes every other daemon call uses. */
export function httpMirrorTransport(siteUrl: string, apiToken: string): VaultMirrorTransport {
  const post = async (route: string, body: Record<string, unknown>): Promise<any> => {
    const resp = await cliFetch(`${siteUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, api_token: apiToken }),
    }, { timeoutMs: REQUEST_TIMEOUT_MS });
    const json = await resp.json();
    if (json?.error) throw new Error(json.error);
    return json;
  };
  return {
    register: (body) => post("/cli/vault/register", body),
    upsert: (body) => post("/cli/vault/upsert", body as any),
    async uploadBody(data) {
      try {
        const uploadUrl: string = await post("/cli/vault/upload-url", {});
        const resp = await cliFetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": "text/markdown" },
          body: new Uint8Array(data),
        }, { timeoutMs: REQUEST_TIMEOUT_MS });
        const { storageId } = await resp.json();
        return typeof storageId === "string" ? storageId : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Build the mirror payload for one note from its bytes. Kept separate from all
 * I/O so the metadata mapping is testable on a string, and so there is exactly
 * one place that decides what a mirrored note looks like.
 *
 * The parser is @codecast/shared/vault's — the SAME one the browser's index
 * worker runs. Two parsers would mean the remote reader's link graph silently
 * disagreeing with the local one.
 */
export function buildMirrorNote(relPath: string, entry: VaultFileEntry, data: Buffer): VaultMirrorNote {
  const base = {
    path: relPath,
    mtime: entry.mtime,
    size: entry.size,
    content_hash: vaultContentHash(data),
  };
  if (!isVaultMarkdownPath(relPath)) {
    // Attachments are listed so a remote tree renders, but they have no note
    // metadata and their bytes never ride this channel.
    return { ...base, title: path.basename(relPath), tags: [], links: [], heading_count: 0 };
  }
  const parsed = parseNote(data.toString("utf8"));
  const tags = [...new Set([...parsed.frontmatterTags, ...parsed.inlineTags.map((t) => t.tag)])];
  const links = [...new Set(parsed.links.map((l) => l.target).filter((t) => t !== ""))];
  return {
    ...base,
    title: parsed.title ?? stripMarkdownExtension(path.basename(relPath)),
    tags,
    links,
    heading_count: parsed.headings.length,
  };
}

function stripMarkdownExtension(name: string): string {
  return name.replace(/\.(md|markdown)$/i, "");
}

/**
 * Split a scan into the three things a push has to say about it: which files
 * need full metadata (their bytes changed, or we have never seen them), which
 * only need their scan stamp refreshed, and which the ledger knew about but the
 * scan no longer sees.
 *
 * Pure — this is the batching/watermark decision, tested directly.
 */
export function diffScanAgainstLedger(
  scanned: VaultFileEntry[],
  ledger: MirrorLedgerEntry | undefined,
): { changed: VaultFileEntry[]; unchanged: string[]; removed: string[] } {
  const known = ledger?.files ?? {};
  const changed: VaultFileEntry[] = [];
  const unchanged: string[] = [];
  const seen = new Set<string>();
  for (const entry of scanned) {
    seen.add(entry.path);
    const prior = known[entry.path];
    // Directories carry no bytes, so mtime and size ARE their whole state.
    // A file still owed a body counts as changed no matter how quiet it is:
    // it is the ONLY way a body deferred by the cycle's upload budget (or lost
    // to a failed upload) ever gets a second attempt.
    const settled = prior && prior.m === entry.mtime && prior.s === entry.size && !prior.p;
    if (settled) unchanged.push(entry.path);
    else changed.push(entry);
  }
  const removed = Object.keys(known).filter((p) => !seen.has(p));
  return { changed, unchanged, removed };
}

/** Bounded-concurrency map. Bodies upload in parallel but never in a stampede. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export class VaultMirror {
  private store: CachedJsonStore<MirrorLedgerEntry>;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private watches = new Map<string, () => void>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();
  private pending = new Set<string>();
  private stopped = false;
  private scanCounter = 0;
  private readonly fullScanIntervalMs: number;
  private readonly eventDebounceMs: number;
  private readonly batchIntervalMs: number;
  private readonly now: () => number;

  constructor(private opts: VaultMirrorOptions) {
    this.fullScanIntervalMs = opts.fullScanIntervalMs ?? FULL_SCAN_INTERVAL_MS;
    this.eventDebounceMs = opts.eventDebounceMs ?? EVENT_DEBOUNCE_MS;
    this.batchIntervalMs = opts.batchIntervalMs ?? BATCH_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.store = new CachedJsonStore<MirrorLedgerEntry>({
      filePath: path.join(opts.configDir, "vault-mirror.json"),
      // Prune on load only what can never be acted on again. An entry for a
      // vault that is no longer mirrored is NOT junk — it is the record that
      // something is still up there to tear down, and reconcileDisabled()
      // deletes it after the teardown lands. What does get dropped is an entry
      // so old that a teardown would be pointless anyway.
      keepOnLoad: (_vaultId, entry) =>
        !entry?.last_scan_at || (this.now() - entry.last_scan_at) < LEDGER_MAX_AGE_MS,
    });
  }

  /** Registered vaults with mirroring explicitly turned on. Read fresh every
   *  time: `cast vault mirror --on` edits config.json under a running daemon. */
  private mirroredVaults(): VaultInfo[] {
    return listVaults(this.opts.configDir).filter((v) => v.mirror === true);
  }

  /** Start the periodic full scan. Nothing is pushed for a vault whose mirror
   *  is off, so this is a no-op on a machine that never opted in. */
  start(): void {
    this.stopped = false;
    void this.syncAll();
    this.scanTimer = setInterval(() => void this.syncAll(), this.fullScanIntervalMs);
    this.scanTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    for (const unsubscribe of this.watches.values()) unsubscribe();
    this.watches.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }

  /** A watcher event touched this vault: coalesce, then push what changed. */
  notify(vaultId: string): void {
    if (this.stopped) return;
    if (this.timers.has(vaultId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(vaultId);
      const vault = this.mirroredVaults().find((v) => v.id === vaultId);
      if (vault) void this.syncVault(vault, { full: false });
    }, this.eventDebounceMs);
    timer.unref?.();
    this.timers.set(vaultId, timer);
  }

  async syncAll(): Promise<void> {
    await this.reconcileDisabled();
    const mirrored = this.mirroredVaults();
    this.reconcileWatches(mirrored);
    for (const vault of mirrored) {
      await this.syncVault(vault, { full: true });
    }
  }

  /**
   * Keep one watch subscription per mirrored vault. Done here, on every cycle,
   * rather than once at boot: `cast vault mirror --on` edits config.json under
   * a running daemon and has no way to tell it, so a subscription list built at
   * startup would leave a freshly mirrored vault waiting for the next half-hour
   * scan before it ever pushed a live edit.
   */
  private reconcileWatches(mirrored: VaultInfo[]): void {
    if (!this.opts.watch) return;
    const live = new Set(mirrored.map((v) => v.id));
    for (const [vaultId, unsubscribe] of this.watches) {
      if (live.has(vaultId)) continue;
      unsubscribe();
      this.watches.delete(vaultId);
    }
    for (const vault of mirrored) {
      if (this.watches.has(vault.id)) continue;
      this.watches.set(vault.id, this.opts.watch(vault, () => this.notify(vault.id)));
    }
  }

  /**
   * Tear down mirrors the user turned off. `cast vault mirror --off` (and
   * `cast vault rm`) only edit config.json — they cannot reach the network, and
   * a CLI process that tried would leave the job half done if it were killed.
   * So the ledger is the to-do list: any vault it remembers pushing that is no
   * longer mirrored gets deleted from Convex, and only then forgotten here.
   */
  private async reconcileDisabled(): Promise<void> {
    const live = new Set(this.mirroredVaults().map((v) => v.id));
    const known = listVaults(this.opts.configDir);
    for (const vaultId of Object.keys(this.store.getAll())) {
      if (this.stopped) return;
      if (live.has(vaultId)) continue;
      const vault = known.find((v) => v.id === vaultId);
      try {
        await this.disable({
          id: vaultId,
          name: vault?.name ?? vaultId,
          root: vault?.root ?? "",
          added_at: vault?.added_at ?? 0,
        });
        this.opts.log?.(`[VAULT-MIRROR] removed remote copy of ${vault?.name ?? vaultId}`);
      } catch (err) {
        // Leave the ledger entry alone so the next cycle tries again.
        this.opts.log?.(`[VAULT-MIRROR] teardown of ${vaultId} failed: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  /**
   * One sync cycle for one vault. Serialized per vault: a full scan and a
   * watcher-driven push racing each other would interleave scan stamps and let
   * the completion sweep delete rows the other cycle had just written. A cycle
   * that arrives while one is running is remembered and run once after.
   */
  async syncVault(vault: VaultInfo, opts: { full: boolean }): Promise<void> {
    if (this.running.has(vault.id)) {
      this.pending.add(vault.id);
      return;
    }
    this.running.add(vault.id);
    try {
      await this.runCycle(vault, opts.full);
    } catch (err) {
      this.opts.log?.(`[VAULT-MIRROR] ${vault.name}: ${(err as Error)?.message ?? err}`);
    } finally {
      this.running.delete(vault.id);
      if (this.pending.delete(vault.id) && !this.stopped) {
        await this.syncVault(vault, { full: false });
      }
    }
  }

  private async runCycle(vault: VaultInfo, full: boolean): Promise<void> {
    // Only a full cycle re-announces the vault. An incremental push can fire
    // every few seconds while someone is typing, and the upsert it sends
    // already carries the name and refreshes last_synced_at — a register on
    // that path would double the writes for nothing.
    if (full) {
      await this.opts.transport.register({
        device_id: this.opts.deviceId,
        vault_id: vault.id,
        name: vault.name,
        root: vault.root,
        enabled: true,
      });
    }

    // Both kinds of cycle scan and diff. Watcher events say only THAT the vault
    // changed; scanning to find out WHAT changed is a few milliseconds locally
    // (the daemon reads its own disk) and it means a missed or coalesced event
    // costs nothing. What the two differ in is what they send: an incremental
    // cycle pushes only the changes, a full one also re-stamps everything else
    // and licenses the server to sweep.
    const scanned = await scanVault(vault.root);
    const ledger = this.store.get(vault.id);
    const { changed, unchanged, removed } = diffScanAgainstLedger(scanned, ledger);
    // A scan id must be unique even when two scans start in the same
    // millisecond, or the sweep could mistake one scan's rows for another's.
    const scanId = full ? `${this.now()}-${++this.scanCounter}` : undefined;

    // A full scan rebuilds the watermark from what it actually saw, so a file
    // deleted while the daemon was down leaves the ledger too. An incremental
    // cycle only layers its changes onto what is already there.
    const nextFiles: Record<string, LedgerFile> = full ? {} : { ...(ledger?.files ?? {}) };
    if (full) {
      for (const p of unchanged) {
        const prior = ledger?.files[p];
        if (prior) nextFiles[p] = prior;
      }
    }

    const notes = await this.buildNotes(vault, changed, ledger, nextFiles);
    for (const p of removed) delete nextFiles[p];

    const batches = chunkMessagesBySize(notes, MAX_NOTES_PER_BATCH, MAX_BATCH_BYTES);
    // An incremental cycle with nothing to say still stops here rather than
    // sending an empty push nobody asked for.
    if (batches.length === 0 && removed.length === 0 && !full) return;

    const noteCount = scanned.filter((f) => !f.dir).length;
    // Every push in this cycle addresses the same vault under the same scan.
    const base: VaultMirrorUpsertRequest = {
      device_id: this.opts.deviceId,
      vault_id: vault.id,
      vault_name: vault.name,
      notes: [],
      ...(scanId ? { scan_id: scanId } : {}),
    };

    let first = true;
    for (const batch of batches) {
      await this.push({
        ...base,
        notes: batch,
        ...(first && removed.length > 0 ? { deleted_paths: removed } : {}),
      });
      first = false;
      await sleep(this.batchIntervalMs);
    }
    if (first && removed.length > 0) {
      await this.push({ ...base, deleted_paths: removed });
    }

    if (full) {
      // Unchanged files ride as bare paths: they need a fresh scan stamp so the
      // sweep spares them, and nothing else.
      for (const chunk of chunkMessagesBySize(unchanged, VAULT_MIRROR_MAX_STAMP_BATCH, MAX_BATCH_BYTES)) {
        await this.push({ ...base, stamp_paths: chunk });
        await sleep(this.batchIntervalMs);
      }
      await this.completeScan(base, noteCount);
    }

    this.store.set(vault.id, { last_scan_at: this.now(), files: nextFiles });
  }

  /** Declare the scan finished and drive the budgeted sweep to the end. */
  private async completeScan(base: VaultMirrorUpsertRequest, noteCount: number): Promise<void> {
    let after: string | undefined;
    for (;;) {
      const result = await this.push({
        ...base,
        complete: true,
        note_count: noteCount,
        ...(after ? { sweep_after_path: after } : {}),
      });
      if (result.sweep_complete || !result.sweep_after_path) return;
      after = result.sweep_after_path;
      await sleep(this.batchIntervalMs);
    }
  }

  private push(body: VaultMirrorUpsertRequest): Promise<VaultMirrorUpsertResponse> {
    return this.opts.transport.upsert(body);
  }

  /**
   * Read, hash, parse and (under the size gate) upload the changed files, and
   * record what happened in the next ledger state. A file that disappears
   * between the scan and the read is simply skipped — the next cycle's scan
   * will report it as removed.
   */
  private async buildNotes(
    vault: VaultInfo,
    changed: VaultFileEntry[],
    ledger: MirrorLedgerEntry | undefined,
    nextFiles: Record<string, LedgerFile>,
  ): Promise<VaultMirrorNote[]> {
    const notes: VaultMirrorNote[] = [];
    let uploadsLeft = MAX_UPLOADS_PER_CYCLE;

    const built = await mapLimit(changed, UPLOAD_CONCURRENCY, async (entry) => {
      if (entry.dir) {
        return {
          note: {
            path: entry.path,
            title: path.basename(entry.path),
            mtime: entry.mtime,
            size: 0,
            content_hash: "",
            tags: [],
            links: [],
            heading_count: 0,
            is_dir: true as const,
          },
          hash: "",
          uploaded: false,
          owed: false,
        };
      }
      const abs = resolveVaultPath(vault.root, entry.path);
      if (!abs) return null;
      let data: Buffer;
      try {
        data = await fsp.readFile(abs);
      } catch {
        return null;
      }
      const note = buildMirrorNote(entry.path, entry, data);
      const prior = ledger?.files[entry.path];
      // Re-upload only when the bytes actually changed. An mtime-only change
      // (a touch, a checkout) reuses the body already in storage.
      const bodyIsCurrent = prior?.h === note.content_hash && prior.u === true;
      const eligible =
        !bodyIsCurrent &&
        isVaultMarkdownPath(entry.path) &&
        data.length > 0 &&
        data.length <= VAULT_MIRROR_MAX_BODY_BYTES;
      // Whatever the cycle budget can't take simply waits for the next cycle;
      // its row lands as metadata-only in the meantime.
      const wantsBody = eligible && uploadsLeft > 0;
      if (wantsBody) uploadsLeft--;
      let uploaded = bodyIsCurrent;
      if (wantsBody) {
        const storageId = await this.opts.transport.uploadBody(data);
        if (storageId) {
          note.body_storage_id = storageId;
          uploaded = true;
        }
      }
      return { note, hash: note.content_hash, uploaded, owed: eligible && !uploaded };
    });

    for (let i = 0; i < built.length; i++) {
      const result = built[i];
      if (!result) continue;
      notes.push(result.note);
      nextFiles[changed[i].path] = {
        m: changed[i].mtime,
        s: changed[i].size,
        h: result.hash,
        ...(result.uploaded ? { u: true } : {}),
        ...(result.owed ? { p: true } : {}),
      };
    }
    return notes;
  }

  /** Tear a vault's mirror down and forget its watermark. Called when the user
   *  turns mirroring off, so "off" means the remote copy is gone. */
  async disable(vault: VaultInfo): Promise<void> {
    for (;;) {
      const result = await this.opts.transport.register({
        device_id: this.opts.deviceId,
        vault_id: vault.id,
        name: vault.name,
        root: vault.root,
        enabled: false,
      });
      if (!result?.more) break;
      await sleep(this.batchIntervalMs);
    }
    this.store.delete(vault.id);
  }
}
