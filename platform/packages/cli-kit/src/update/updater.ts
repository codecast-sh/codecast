// Self update for a compiled single binary CLI. Ported from codecast's
// packages/cli/src/update.ts and parameterized: product and binary names, the
// release base URL, channels, the minimum version source, and every side
// effect (fetch, file system, download, clock) are injected so the logic runs
// unchanged for any product and fully under test.

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
import { type ReleaseManifest, isReleaseManifest } from "./manifest.js";

export interface UpdaterFs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
  readTextSync(p: string): string;
  writeTextSync(p: string, text: string): void;
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
  // Injected side effects. Each has a production default.
  fetch?: typeof fetch;
  fs?: UpdaterFs;
  /** Download `url` to `dest`. Default streams through fetch. Codecast passes a
   *  curl based download because fetch is unreliable under launchd. */
  download?: (url: string, dest: string) => Promise<void>;
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

export class Updater {
  private readonly cfg: Required<
    Pick<UpdaterConfig, "checkIntervalMs" | "retryIntervalMs" | "fetch" | "fs" | "execPath" | "platform" | "arch" | "now" | "log">
  > &
    UpdaterConfig;
  private readonly channels: ChannelSpec[];
  private readonly stateFile: string;

  constructor(config: UpdaterConfig) {
    this.cfg = {
      checkIntervalMs: DAY,
      retryIntervalMs: 6 * 60 * 60 * 1000,
      fetch: globalThis.fetch,
      fs: nodeUpdaterFs,
      execPath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      now: () => Date.now(),
      log: (line) => console.log(line),
      ...config,
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

  async fetchManifest(channel: ChannelSpec = this.getChannel()): Promise<ReleaseManifest | null> {
    try {
      const response = await this.cfg.fetch(manifestUrl(this.cfg.releaseBaseUrl, channel));
      if (!response.ok) return null;
      const body: unknown = await response.json();
      return isReleaseManifest(body) ? body : null;
    } catch {
      return null;
    }
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
      const channel = this.getChannel();
      const response = await this.cfg.fetch(manifestUrl(this.cfg.releaseBaseUrl, channel));
      if (!response.ok) return { success: false, error: `fetch_latest_${response.status}` };
      const body: unknown = await response.json();
      if (!isReleaseManifest(body)) return { success: false, error: "bad_manifest" };
      const latest = body;
      const binary = latest.binaries[key];
      if (!binary) return { success: false, error: `no_binary_${key}` };

      this.cfg.log(`Downloading ${this.cfg.productName} v${latest.version}...`);
      cleanupNew();
      await this.download(binary.url, newExe);

      const check = await verifySha256(fs.readFileSync(newExe), binary.sha256);
      if (!check.ok) {
        cleanupNew();
        return { success: false, error: `checksum_mismatch_${key}` };
      }

      fs.chmodSync(newExe, 0o755);
      if (fs.existsSync(backupExe)) fs.unlinkSync(backupExe);
      fs.renameSync(currentExe, backupExe);
      fs.renameSync(newExe, currentExe);
      try { fs.unlinkSync(backupExe); } catch {}

      const state = this.readState();
      state.availableVersion = undefined;
      state.failedVersion = undefined;
      state.failedAt = undefined;
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

  private async download(url: string, dest: string): Promise<void> {
    if (this.cfg.download) return this.cfg.download(url, dest);
    const response = await this.cfg.fetch(url);
    if (!response.ok) throw new Error(`download_${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    nodeFs.writeFileSync(dest, bytes);
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

export function createUpdater(config: UpdaterConfig): Updater {
  return new Updater(config);
}
