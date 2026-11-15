/**
 * The host end of `cast computer --on laptop` (docs/architecture/computer-remote.md):
 * the laptop's apps, reached through the laptop link `cast browser` already
 * uses. One socket for the life of the process, opened on the first request.
 * The laptop decides what is allowed; this side only says plainly why not.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { WebSocket } from "ws";
import { pickLaptopLink, proveLaptopBridge, readLaptopLinks, ownUserId, type LaptopLink } from "../browser/bridge/laptopLink.js";
import { CLOSE_BAD_TOKEN } from "../browser/bridge/protocol.js";
import { ComputerError, asComputerError, grantSetupLines, computerErrorFromWire } from "./errors.js";
import { CLOSE_NOT_GRANTED, parseScreenshotFrame } from "./remoteServe.js";
import { screenshotDir, SCREENSHOT_TTL_MS } from "./screenshotFile.js";
import type { ComputerClientLike } from "./run.js";
import type { ComputerActionMethod, ComputerActionResult, ComputerListAppsResult, ComputerListWindowsResult, ComputerProviderCapabilities, ComputerSnapshotResult } from "./types.js";

const REQUEST_TIMEOUT_MS = 60_000;
const CONNECT_BUDGET_MS = 5_000;

export interface RemoteClientOptions {
  /** `laptop`, or a laptop's name or device id when several are linked. */
  on: string;
  session: string | null;
  /** The host's browser home, where the links live; tests point it elsewhere. */
  home?: string;
  owner?: string | null;
  requestTimeoutMs?: number;
  /** Where received captures are written; the CLI's own screenshot dir by default. */
  screenshotDir?: string;
}

const refused = (message: string) => new ComputerError("remote_refused", message);

/** The link `--on` names among this person's linked laptops, or the refusal that says what is missing. */
export function chooseLaptop(o: Pick<RemoteClientOptions, "on" | "home" | "owner">): LaptopLink {
  const links = readLaptopLinks(o.home, o.owner === undefined ? ownUserId() : o.owner);
  const pick = pickLaptopLink(links, o.on);
  if ("error" in pick) throw refused(pick.error);
  return pick.link;
}

/** A helper failure from the laptop, said as the laptop's: its grants are the person's to give there. */
export function laptopError(laptop: string, wire: unknown): ComputerError {
  const e = computerErrorFromWire(wire);
  if (e.code === "remote_refused") return e;
  if (grantSetupLines(e).length) return refused(`${laptop}'s computer helper: ${e.message}. Only your person can grant it, on ${laptop}: cast devices setup ${laptop} computer --start`);
  return new ComputerError(e.code, `on ${laptop}: ${e.message}`);
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; method: string }

export class RemoteComputerClient implements ComputerClientLike {
  private ws: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private link: LaptopLink | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly frames = new Map<number, { contentType: string; bytes: Buffer }>();

  constructor(private readonly o: RemoteClientOptions) {}

  get laptop(): string | null { return this.link?.laptop ?? null; }

  capabilities(): Promise<ComputerProviderCapabilities> { return this.request("capabilities", {}) as Promise<ComputerProviderCapabilities>; }
  listApps(): Promise<ComputerListAppsResult> { return this.request("listApps", {}) as Promise<ComputerListAppsResult>; }
  listWindows(params: unknown): Promise<ComputerListWindowsResult> { return this.request("listWindows", params) as Promise<ComputerListWindowsResult>; }
  getAppState(params: unknown): Promise<ComputerSnapshotResult> { return this.request("getAppState", params) as Promise<ComputerSnapshotResult>; }
  action(method: ComputerActionMethod, params: unknown): Promise<ComputerActionResult> { return this.request(method, params) as Promise<ComputerActionResult>; }

  shutdown(): void {
    const ws = this.ws;
    this.ws = null;
    this.opening = null;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000);
    this.failAll(new ComputerError("accessibility_error", "the link to the laptop was closed"));
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const ws = await this.connect();
    const id = this.nextId++;
    const laptop = this.link!.laptop;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ComputerError("action_timeout", `${laptop}'s computer helper did not answer ${method} in time; it may still be working there`));
      }, this.o.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  private connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    this.opening ??= this.open().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async open(): Promise<WebSocket> {
    const link = this.link ?? chooseLaptop(this.o);
    this.link = link;
    const notProven = await proveLaptopBridge(link);
    if (notProven) throw refused(notProven.mode === "host" ? `${link.laptop}: ${notProven.reason}` : `${link.laptop} could not be reached`);
    const q = new URLSearchParams({ token: link.token, ...(this.o.session ? { session: this.o.session } : {}) });
    const ws = new WebSocket(`ws://127.0.0.1:${link.port}/computer?${q}`, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(refused(`${link.laptop} did not open its apps socket in time`)); }, CONNECT_BUDGET_MS);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        reject(refused(res.statusCode === 403
          ? `${link.laptop} runs a cast too old to share its apps: cast devices update ${link.laptop}`
          : `${link.laptop} refused the apps socket (HTTP ${res.statusCode})`));
      });
      ws.once("error", (err) => { clearTimeout(timer); reject(refused(`${link.laptop}: ${err.message}`)); });
    });
    ws.on("message", (raw: Buffer, isBinary: boolean) => this.onMessage(raw, isBinary));
    ws.on("close", (code: number) => {
      if (this.ws === ws) this.ws = null;
      const why =
        code === CLOSE_NOT_GRANTED ? refused(`${link.laptop} revoked this host's access to its apps`)
        : code === CLOSE_BAD_TOKEN ? refused(`${link.laptop} refused this host's key (revoked there, or the link was renewed); retry once, then ask your person`)
        : new ComputerError("accessibility_error", `the link to ${link.laptop} closed mid-command; nothing after the last answered step ran`);
      this.failAll(why);
    });
    ws.on("error", () => {});
    this.ws = ws;
    return ws;
  }

  private onMessage(raw: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const f = parseScreenshotFrame(raw);
      if (f) this.frames.set(f.id, { contentType: f.contentType, bytes: Buffer.from(f.bytes) });
      return;
    }
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: unknown };
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id!);
    const frame = this.frames.get(msg.id!);
    this.frames.delete(msg.id!);
    if (!msg.ok) return p.reject(laptopError(this.link!.laptop, msg.error));
    try {
      p.resolve(frame ? this.landScreenshot(msg.result as ComputerSnapshotResult, frame) : msg.result);
    } catch (err) {
      p.reject(asComputerError(err));
    }
  }

  /**
   * The capture as this machine's own file, 0600 in the CLI's screenshot dir,
   * named for the snapshot like a local one so the sweep finds it.
   */
  private landScreenshot(result: ComputerSnapshotResult, frame: { contentType: string; bytes: Buffer }): ComputerSnapshotResult {
    const shot = result.screenshot as (NonNullable<ComputerSnapshotResult["screenshot"]> & { bytes?: number; contentType?: string }) | null;
    if (!shot) return result;
    const dir = this.o.screenshotDir ?? screenshotDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = (result.snapshot?.id ?? `r${Date.now()}`).replace(/[^\w.-]/g, "_");
    const file = path.join(dir, `remote-${id}-screenshot.png`);
    fs.writeFileSync(file, frame.bytes, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const { contentType: _ct, ...rest } = shot;
    return {
      ...result,
      screenshot: { ...rest, bytes: frame.bytes.length, path: file, expiresAt: new Date(Date.now() + SCREENSHOT_TTL_MS).toISOString() } as typeof result.screenshot,
    };
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
    this.frames.clear();
  }
}
