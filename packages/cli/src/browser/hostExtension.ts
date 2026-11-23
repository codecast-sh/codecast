/**
 * The Codecast extension inside a cloud host's own Chrome.
 *
 * A host has no human to install the extension from the Web Store and click
 * Pair, so cast does both itself, through the debugging port it already holds
 * on the Chrome it launched (managedBrowser.ts):
 *
 *   1. Load. Branded Chrome ignores `--load-extension` since 137, and Mac
 *      Chrome honours force-install policy only under MDM. CDP's
 *      `Extensions.loadUnpacked` works on branded Chrome when it was started
 *      with `--enable-unsafe-extension-debugging` (instance.ts), and the
 *      manifest's `key` gives the copy the Store's id, so the bridge accepts
 *      it like any other install. A load lasts until Chrome exits, so every
 *      launch loads it again; its storage (the pairing key) stays in the
 *      profile. The files come from this CLI (`extension.tar`, written by the
 *      build), so the extension always speaks this CLI's bridge protocol,
 *      whatever the Store has published.
 *   2. Pair. The options page's Pair button stores a one-time code and asks
 *      the worker to reconnect. Here the same two steps run inside the
 *      worker over CDP, with a code minted by this machine's bridge host
 *      (pairing.ts), so the handshake and the key it issues are the ordinary
 *      ones.
 *
 * With both done the host's Chrome is driven the way a laptop's is, through
 * the bridge and the extension: handoff cards, the session's tab group, the
 * toolbar's take back. The CDP port stays too, for carrying logins in
 * (sync.ts) and the screencast a viewer watches.
 */

import { execFileSync } from "../proc.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import extensionTar from "./extension.tar" with { type: "file" };
import { CdpConnection } from "./cdp.js";
import { browserHome } from "./profile.js";
import { BRIDGE_EXTENSION_ID } from "./bridge/protocol.js";
import type { BridgeHostStatus, ProvenBridge } from "./bridge/host.js";

/** Where the embedded tar sits, in a compiled binary, a dist bundle or a source checkout. */
function payloadPath(): string {
  return path.isAbsolute(extensionTar) ? extensionTar : fileURLToPath(new URL(extensionTar, import.meta.url));
}

/** packages/browser-extension beside this file, when cast runs from a source checkout. */
function sourceExtensionDir(): string | null {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../browser-extension");
  return fs.existsSync(path.join(dir, "manifest.json")) ? dir : null;
}

/**
 * A directory holding the unpacked extension this CLI carries, or null when it
 * carries none. The tar is unpacked once per content hash, so a new release
 * lands beside the old copy instead of under a Chrome that has it loaded.
 */
export function hostExtensionDir(): string | null {
  const tar = payloadPath();
  const bytes = fs.existsSync(tar) ? fs.readFileSync(tar) : Buffer.alloc(0);
  if (!bytes.length) return sourceExtensionDir();
  const dir = path.join(browserHome(), "extension", createHash("sha256").update(bytes).digest("hex").slice(0, 12));
  if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const tarFile = path.join(tmp, "..", `${path.basename(tmp)}.tar`);
  fs.writeFileSync(tarFile, bytes);
  try {
    execFileSync("tar", ["-xf", tarFile, "-C", tmp], { stdio: "ignore" });
  } finally {
    fs.rmSync(tarFile, { force: true });
  }
  try {
    fs.renameSync(tmp, dir);
  } catch {
    // Another process unpacked the same content first.
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return fs.existsSync(path.join(dir, "manifest.json")) ? dir : null;
}

/** The version in the carried manifest, for status lines. */
export function hostExtensionVersion(dir = hostExtensionDir()): string | null {
  if (!dir) return null;
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** Load the carried extension into the Chrome on this debugging port. Resolves with its id. */
export async function loadHostExtension(port: number, dir = hostExtensionDir()): Promise<string> {
  if (!dir) throw new Error("this cast carries no copy of the Codecast extension");
  const conn = await CdpConnection.fromPort(port);
  try {
    const { id } = await conn.send<{ id: string }>("Extensions.loadUnpacked", { path: dir }, undefined, 20_000);
    if (id !== BRIDGE_EXTENSION_ID) throw new Error(`Chrome loaded the extension as ${id}, not ${BRIDGE_EXTENSION_ID}: its manifest has no key`);
    return id;
  } catch (err) {
    const msg = (err as Error).message;
    if (/not found|wasn't found|not allowed|unsafe/i.test(msg)) {
      throw new Error("this Chrome was started without --enable-unsafe-extension-debugging (it predates this cast); it gets the extension on its next start");
    }
    throw err;
  } finally {
    conn.close();
  }
}

/**
 * Hand the extension in this Chrome a one-time pairing code for the bridge
 * host on `bridgePort`: what the options page's Pair button does, run in the
 * worker. Waits for the worker to come up after a fresh load.
 */
export async function pairHostExtension(port: number, bridgePort: number, code: string, timeoutMs = 20_000): Promise<void> {
  const conn = await CdpConnection.fromPort(port);
  try {
    const deadline = Date.now() + timeoutMs;
    let worker: string | null = null;
    while (!worker) {
      const { targetInfos } = await conn.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>("Target.getTargets");
      worker = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${BRIDGE_EXTENSION_ID}/`))?.targetId ?? null;
      if (worker) break;
      if (Date.now() > deadline) throw new Error("the extension's worker did not start");
      await new Promise((r) => setTimeout(r, 500));
    }
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: worker, flatten: true });
    const bridge = { port: bridgePort, code, codeExpiresAt: Date.now() + 10 * 60_000 };
    const r = await conn.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression: `chrome.storage.local.set({ bridge: ${JSON.stringify(bridge)} }).then(() => { reconnect(); return "ok"; })`, awaitPromise: true, returnByValue: true },
      sessionId,
      15_000,
    );
    if (r.result?.value !== "ok") throw new Error(`the extension's worker refused the code: ${r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text ?? "no answer"}`);
  } finally {
    conn.close();
  }
}

export type HostChromeReady =
  | { ok: true; bridge: ProvenBridge; status: BridgeHostStatus; paired: boolean }
  | { ok: false; reason: string };

/**
 * This host's Chrome up, the extension loaded in it and connected to this
 * host's bridge, pairing it first when it never has been. Every step is the
 * no-op it should be when already done: a connected extension returns at
 * once. `ok: false` says why the host's Chrome is driven without it.
 */
export async function readyHostChrome(note: (line: string) => void = () => {}): Promise<HostChromeReady> {
  const { ensureBridgeHost, waitForExtension, readBridgeState, writeBridgeState } = await import("./bridge/host.js");
  const { mintPairingCode } = await import("./bridge/pairing.js");
  const bridge = await ensureBridgeHost(undefined, { note });
  let status = await waitForExtension(bridge, 1_500);
  if (status.extensionConnected) return { ok: true, bridge, status, paired: false };

  const { startLocalBrowser, DEFAULT_START } = await import("./managedBrowser.js");
  const inst = await startLocalBrowser({ ...DEFAULT_START, quiet: true });
  if (inst.hostExtension !== true) return { ok: false, reason: inst.hostExtension ?? "this Chrome was started before cast carried the extension; it gets it on its next start" };
  // A profile paired before reconnects on its own within seconds of the load.
  if (readBridgeState()?.hostChrome) {
    status = await waitForExtension(bridge, 8_000);
    if (status.extensionConnected) return { ok: true, bridge, status, paired: false };
  }
  // Marked before the extension connects, so no process in between reads
  // the pairing as a human's Chrome (real.ts hostHasNoHumanChrome).
  writeBridgeState({ ...(readBridgeState() ?? bridge), hostChrome: true });
  note("pairing the Codecast extension in this host's Chrome…");
  await pairHostExtension(inst.port, bridge.port, mintPairingCode(null));
  status = await waitForExtension(bridge, 20_000);
  return status.extensionConnected
    ? { ok: true, bridge, status, paired: true }
    : { ok: false, reason: "the extension took the pairing code but did not connect to this host's bridge" };
}
