// Self update for a compiled single binary CLI. Ported from codecast's
// packages/cli/src/update.ts and parameterized: product and binary names, the
// release base URL, channels, the minimum version source, and every side
// effect (fetch, file system, download, clock) are injected so the logic runs
// unchanged for any product and fully under test.
//
// Trust model. The manifest is fetched from the release origin over https.
// Every binary entry is checked before a download starts (checkBinaryEntry:
// https, the release origin, a plain asset path, a bare hex digest, a size
// inside the bound), the download is bounded and may only follow redirects
// that stay on the origin, and the bytes are hashed before the running
// executable is touched. The swap keeps the old binary until the new one is in
// place and puts it back if the swap fails part way. A manifest that carries a
// signature is verified against the pinned keys (see manifestSigning below)
// before any of its content is read.

import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
  type ChannelSpec,
  type UpdateDecision,
  STABLE_CHANNEL,
  assetName,
  compareVersions,
  decideUpdate,
  manifestUrl,
  platformKey,
  resolveChannel,
} from "./version.js";
import { verifySha256 } from "./checksum.js";
import { type ReleaseManifest, checkBinaryEntry, isReleaseManifest, releaseOrigin } from "./manifest.js";
import { type ManifestSigningPolicy, type SignatureAccepted, verifyManifestSignature } from "./signing.js";

export interface UpdaterFs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
  readTextSync(p: string): string;
  writeTextSync(p: string, text: string): void;
  writeFileSync(p: string, bytes: Uint8Array): void;
  mkdirSync(p: string): void;
  unlinkSync(p: string): void;
  renameSync(from: string, to: string): void;
  chmodSync(p: string, mode: number): void;
  readlinkSync(p: string): string;
  symlinkSync(target: string, linkPath: string): void;
}

export const nodeUpdaterFs: UpdaterFs = {
  existsSync: (p) => nodeFs.existsSync(p),
  readFileSync: (p) => new Uint8Array(nodeFs.readFileSync(p)),
  readTextSync: (p) => nodeFs.readFileSync(p, "utf-8"),
  writeTextSync: (p, text) => nodeFs.writeFileSync(p, text),
  writeFileSync: (p, bytes) => nodeFs.writeFileSync(p, bytes),
  mkdirSync: (p) => nodeFs.mkdirSync(p, { recursive: true }),
  unlinkSync: (p) => nodeFs.unlinkSync(p),
  renameSync: (from, to) => nodeFs.renameSync(from, to),
  chmodSync: (p, mode) => nodeFs.chmodSync(p, mode),
  readlinkSync: (p) => nodeFs.readlinkSync(p),
  symlinkSync: (target, linkPath) => nodeFs.symlinkSync(target, linkPath),
};

export interface UpdateState {
  lastCheck?: string;
  availableVersion?: string;
  dismissed?: string;
  failedVersion?: string;
  failedAt?: string;
  channel?: string;
  /** The `released` stamp of the newest manifest whose signature verified.
   *  A later signed manifest may not carry an older stamp (anti-rollback). */
  lastSignedReleased?: string;
}

/** What a product's download callback is handed beside the URL. */
export interface DownloadOptions {
  /** Refuse more bytes than this. */
  maxBytes: number;
  /** The only origin a redirect may land on. */
  origin: string;
}

export interface UpdaterConfig {
  /** Human name, used in messages: "Codecast". */
  productName: string;
  /** Binary file name and the prefix of every release asset: "codecast". */
  binaryName: string;
  /** Short alias symlinked beside the binary after an update: "cast". Optional. */
  aliasName?: string;
  currentVersion: string;
  /** "https://dl.example.com". Manifests and binaries live under it. */
  releaseBaseUrl: string;
  /** First entry is the default channel. Defaults to a single stable channel. */
  channels?: ChannelSpec[];
  /** Directory for update-state.json, for example ~/.codecast. */
  stateDir: string;
  /** The fleet minimum, read from the backend (systemConfig min_cli_version).
   *  Return null when no minimum is set or the backend is unreachable. */
  minVersion?: () => Promise<string | null>;
  /** How often to poll the manifest. Default 24 hours. */
  checkIntervalMs?: number;
  /** How long to wait before retrying a failed install of one version. Default 6 hours. */
  retryIntervalMs?: number;
  /** The name the user types to update: "cast update". Shown in the notice. */
  updateCommand?: string;
  /** Largest binary the updater will download or install. Default 512 MiB. */
  maxBinaryBytes?: number;
  /** Manifest signature policy. Absent or without keys: signatures are not
   *  checked, which is how every client in the field behaves today. */
  manifestSigning?: ManifestSigningPolicy;
  /** Verify the platform's own code signature on the downloaded binary before
   *  it replaces the running one. Absent: no platform check. Return ok:false
   *  to refuse; the reason is reported as the update error. */
  verifyPlatformSignature?: (binaryPath: string) => Promise<{ ok: boolean; reason?: string }>;
  // Injected side effects. Each has a production default.
  fetch?: typeof fetch;
  fs?: UpdaterFs;
  /** Download `url` to `dest`, honouring the bounds in `opts`. Default streams
   *  through fetch. Codecast passes a curl based download because fetch is
   *  unreliable under launchd. Must throw on any failure. */
  download?: (url: string, dest: string, opts: DownloadOptions) => Promise<void>;
  execPath?: string;
  platform?: string;
  arch?: string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface UpdateResult {
  success: boolean;
  version?: string;
  error?: string;
}

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BINARY_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

/** Why a manifest could not be used. Each is an update error verbatim. */
export type ManifestError =
  | `fetch_latest_${number}`
  | "fetch_latest_failed"
  | "manifest_too_large"
  | "bad_manifest"
  | `manifest_signature_${string}`
  | "manifest_rollback_refused";

export type LoadedManifest =
  | { ok: true; manifest: ReleaseManifest; signature: SignatureAccepted }
  | { ok: false; error: ManifestError };

export class Updater {
  private readonly cfg: Required<
    Pick<UpdaterConfig, "checkIntervalMs" | "retryIntervalMs" | "maxBinaryBytes" | "fetch" | "fs" | "execPath" | "platform" | "arch" | "now" | "log">
  > &
    UpdaterConfig;
  private readonly channels: ChannelSpec[];
  private readonly stateFile: string;

  constructor(config: UpdaterConfig) {
    this.cfg = {
      checkIntervalMs: DAY,
      retryIntervalMs: 6 * 60 * 60 * 1000,
      maxBinaryBytes: DEFAULT_MAX_BINARY_BYTES,
      fetch: globalThis.fetch,
      fs: nodeUpdaterFs,
      execPath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      now: () => Date.now(),
      log: (line) => console.log(line),
      ...stripUndefined(config),
    };
    this.channels = config.channels && config.channels.length > 0 ? config.channels : [STABLE_CHANNEL];
    this.stateFile = path.join(config.stateDir, "update-state.json");
  }

  // ── state ──
  readState(): UpdateState {
    try {
      if (this.cfg.fs.existsSync(this.stateFile)) {
        return JSON.parse(this.cfg.fs.readTextSync(this.stateFile)) as UpdateState;
      }
    } catch {}
    return {};
  }

  writeState(state: UpdateState): void {
    try {
      if (!this.cfg.fs.existsSync(this.cfg.stateDir)) this.cfg.fs.mkdirSync(this.cfg.stateDir);
      this.cfg.fs.writeTextSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch {}
  }

  // ── channels ──
  getChannel(requested?: string | null): ChannelSpec {
    return resolveChannel(this.channels, requested, this.readState().channel);
  }

  setChannel(name: string): ChannelSpec {
    const channel = resolveChannel(this.channels, name);
    const state = this.readState();
    state.channel = channel.name;
    state.availableVersion = undefined;
    state.lastCheck = undefined;
    this.writeState(state);
    return channel;
  }

  listChannels(): ChannelSpec[] {
    return [...this.channels];
  }

  get platformKey(): string {
    return platformKey(this.cfg.platform, this.cfg.arch);
  }

  /** True when running from source (bun) rather than a compiled binary. An
   *  update would overwrite the interpreter, so the updater refuses. */
  isDevMode(): boolean {
    const exe = this.cfg.execPath.toLowerCase();
    const bin = this.cfg.binaryName.toLowerCase();
    const alias = this.cfg.aliasName?.toLowerCase();
    return exe.includes("bun") || (!exe.includes(bin) && !(alias && exe.includes(`/${alias}`)));
  }

  /**
   * Fetch, bound, verify and parse one channel's manifest. The one path every
   * reader of latest.json goes through, so a manifest that fails a check is
   * invisible to the version poll and the installer alike.
   */
  async loadManifest(channel: ChannelSpec = this.getChannel()): Promise<LoadedManifest> {
    const url = manifestUrl(this.cfg.releaseBaseUrl, channel);
    let bytes: Uint8Array;
    try {
      const response = await this.cfg.fetch(url);
      if (!response.ok) return { ok: false, error: `fetch_latest_${response.status}` };
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      return { ok: false, error: "fetch_latest_failed" };
    }
    if (bytes.byteLength > MAX_MANIFEST_BYTES) return { ok: false, error: "manifest_too_large" };

    // The signature is over the exact manifest bytes, so it is checked before
    // the bytes are parsed. A policy with no keys skips this entirely.
    const signature = await verifyManifestSignature({
      manifestBytes: bytes,
      signatureUrl: `${url}.sig`,
      policy: this.cfg.manifestSigning,
      fetch: this.cfg.fetch,
    });
    if (!signature.ok) return { ok: false, error: `manifest_signature_${signature.reason}` };

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return { ok: false, error: "bad_manifest" };
    }
    if (!isReleaseManifest(body)) return { ok: false, error: "bad_manifest" };

    // Anti-rollback, only meaningful for a manifest a key vouched for: a
    // replayed older signed manifest cannot walk a client back to a version
    // the publisher has since replaced. Legitimate recovery republishes with
    // a fresh `released` stamp, which the pipeline does.
    if (signature.verified) {
      const last = this.readState().lastSignedReleased;
      if (last && typeof body.released === "string" && body.released && body.released < last) {
        return { ok: false, error: "manifest_rollback_refused" };
      }
    }
    return { ok: true, manifest: body, signature };
  }

  async fetchManifest(channel: ChannelSpec = this.getChannel()): Promise<ReleaseManifest | null> {
    const loaded = await this.loadManifest(channel);
    return loaded.ok ? loaded.manifest : null;
  }

  /** Poll the manifest at most once per check interval (unless forced) and
   *  return the newer version if one exists. Cached between polls. */
  async checkForUpdates(force = false): Promise<string | null> {
    const state = this.readState();
    const now = this.cfg.now();
    if (!force && state.lastCheck) {
      const last = new Date(state.lastCheck).getTime();
      if (now - last < this.cfg.checkIntervalMs) {
        if (state.availableVersion && compareVersions(state.availableVersion, this.cfg.currentVersion) > 0) {
          return state.availableVersion;
        }
        return null;
      }
    }
    const latest = await this.fetchManifest();
    if (!latest) return null;
    state.lastCheck = new Date(now).toISOString();
    if (compareVersions(latest.version, this.cfg.currentVersion) > 0) {
      state.availableVersion = latest.version;
      this.writeState(state);
      return latest.version;
    }
    state.availableVersion = undefined;
    this.writeState(state);
    return null;
  }

  /** Combine the manifest and the fleet minimum into one decision. The daemon
   *  calls this on its heartbeat: "forced" means update now and restart. */
  async decide(): Promise<UpdateDecision> {
    const [latest, minimum] = await Promise.all([
      this.fetchManifest(),
      this.cfg.minVersion ? this.cfg.minVersion().catch(() => null) : Promise.resolve(null),
    ]);
    return decideUpdate({ current: this.cfg.currentVersion, latest: latest?.version ?? null, minimum });
  }

  updateRecentlyFailed(version: string): boolean {
    const state = this.readState();
    if (state.failedVersion !== version || !state.failedAt) return false;
    return this.cfg.now() - new Date(state.failedAt).getTime() < this.cfg.retryIntervalMs;
  }

  recordUpdateFailure(version: string): void {
    const state = this.readState();
    state.failedVersion = version;
    state.failedAt = new Date(this.cfg.now()).toISOString();
    this.writeState(state);
  }

  /** Download the binary for this platform, verify its SHA-256 against the
   *  manifest, and swap it in place of the running executable. */
  async performUpdate(): Promise<UpdateResult> {
    if (this.isDevMode()) return { success: false, error: "dev_mode" };
    const fs = this.cfg.fs;
    const key = this.platformKey;
    const currentExe = this.cfg.execPath;
    const newExe = currentExe + ".new";
    const backupExe = currentExe + ".backup";
    const cleanupNew = () => {
      try { fs.unlinkSync(newExe); } catch {}
    };
    try {
      const loaded = await this.loadManifest();
      if (!loaded.ok) return { success: false, error: loaded.error };
      const latest = loaded.manifest;
      const binary = latest.binaries[key];
      if (!binary) return { success: false, error: `no_binary_${key}` };

      const maxBytes = this.cfg.maxBinaryBytes;
      const check = checkBinaryEntry(binary, { releaseBaseUrl: this.cfg.releaseBaseUrl, maxBytes });
      if (!check.ok) {
        const kind = check.error === "digest_malformed" ? "digest" : check.error === "size_out_of_bounds" ? "size" : "binary_url";
        return { success: false, error: `bad_${kind}_${key}` };
      }

      this.cfg.log(`Downloading ${this.cfg.productName} v${latest.version}...`);
      cleanupNew();
      await this.download(check.url.href, newExe, { maxBytes, origin: releaseOrigin(this.cfg.releaseBaseUrl) });

      const bytes = fs.readFileSync(newExe);
      if (bytes.byteLength > maxBytes || (binary.size !== undefined && bytes.byteLength !== binary.size)) {
        cleanupNew();
        return { success: false, error: bytes.byteLength > maxBytes ? "download_too_large" : "download_incomplete" };
      }
      const digest = await verifySha256(bytes, binary.sha256);
      if (!digest.ok) {
        cleanupNew();
        return { success: false, error: `checksum_mismatch_${key}` };
      }
      if (this.cfg.verifyPlatformSignature) {
        const sig = await this.cfg.verifyPlatformSignature(newExe);
        if (!sig.ok) {
          cleanupNew();
          return { success: false, error: `platform_signature_${sig.reason ?? "refused"}` };
        }
      }

      fs.chmodSync(newExe, 0o755);
      this.swap(currentExe, newExe, backupExe);

      const state = this.readState();
      state.availableVersion = undefined;
      state.failedVersion = undefined;
      state.failedAt = undefined;
      if (loaded.signature.verified && latest.released) state.lastSignedReleased = latest.released;
      this.writeState(state);

      this.cfg.log(`Updated to v${latest.version}`);
      this.ensureAlias();
      return { success: true, version: latest.version };
    } catch (err) {
      cleanupNew();
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /**
   * Put the verified file in the running binary's place. The old binary moves
   * aside first and comes back if the new one cannot take its place, so a
   * failure part way leaves a runnable executable, never a missing one.
   */
  private swap(currentExe: string, newExe: string, backupExe: string): void {
    const fs = this.cfg.fs;
    if (fs.existsSync(backupExe)) fs.unlinkSync(backupExe);
    fs.renameSync(currentExe, backupExe);
    try {
      fs.renameSync(newExe, currentExe);
    } catch (err) {
      try { fs.renameSync(backupExe, currentExe); } catch {}
      throw err;
    }
    try { fs.unlinkSync(backupExe); } catch {}
  }

  private async download(url: string, dest: string, opts: DownloadOptions): Promise<void> {
    if (this.cfg.download) return this.cfg.download(url, dest, opts);
    this.cfg.fs.writeFileSync(dest, await fetchBounded(this.cfg.fetch, url, opts));
  }

  /** Keep the short alias (for example `cast` beside `codecast`) pointing at
   *  the binary. Never clobbers a regular file that happens to share the name. */
  ensureAlias(): void {
    const alias = this.cfg.aliasName;
    if (!alias || this.isDevMode()) return;
    const fs = this.cfg.fs;
    const exe = this.cfg.execPath;
    const link = path.join(path.dirname(exe), alias);
    try {
      const target = fs.readlinkSync(link);
      if (target === exe) return;
      fs.unlinkSync(link);
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code !== "ENOENT") return;
    }
    try { fs.symlinkSync(exe, link); } catch {}
  }

  updateNotice(availableVersion: string): string {
    const cmd = this.cfg.updateCommand ?? `${this.cfg.aliasName ?? this.cfg.binaryName} update`;
    return `\n  Update available: v${this.cfg.currentVersion} -> v${availableVersion}\n  Run '${cmd}' to update\n`;
  }

  showUpdateNotice(availableVersion: string): void {
    this.cfg.log(this.updateNotice(availableVersion));
  }

  /** Release asset name for a platform key, matching the release pipeline. */
  assetName(key: string = this.platformKey): string {
    return assetName(this.cfg.binaryName, key);
  }
}

/**
 * Download with the transport under our own control: redirects are followed
 * by hand so every hop is checked against the release origin and https, the
 * body is refused past the bound whether or not a length was declared, and a
 * body shorter than its declared length is a partial download, not a file.
 */
export async function fetchBounded(fetchFn: typeof fetch, url: string, opts: DownloadOptions): Promise<Uint8Array> {
  let current = url;
  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchFn(current, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`download_${res.status}`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error("download_redirect_refused");
      }
      if (next.protocol !== "https:" || next.origin !== opts.origin) throw new Error("download_redirect_refused");
      current = next.href;
      continue;
    }
    response = res;
    break;
  }
  if (!response) throw new Error("download_too_many_redirects");
  if (!response.ok) throw new Error(`download_${response.status}`);

  const declared = response.headers.get("content-length");
  const expected = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
  if (expected !== null && expected > opts.maxBytes) throw new Error("download_too_large");

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("download_no_body");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > opts.maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("download_too_large");
    }
    chunks.push(value);
  }
  if (expected !== null && total !== expected) throw new Error("download_incomplete");
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Spread-safe copy: an explicit `undefined` in the config must not shadow a default. */
function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function createUpdater(config: UpdaterConfig): Updater {
  return new Updater(config);
}
