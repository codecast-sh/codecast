/**
 * Automatic screenshots after page-changing commands.
 *
 * The inline-image pipeline already exists end to end: a command prints one
 * marker line (inlineImage.ts), the daemon parser lifts it onto the message,
 * sync uploads it, the web renders it under the command. What was missing is
 * the discipline of using it — agents forget to run `shot`, so most browser
 * threads are text-only. This module closes that gap by capturing a small
 * screenshot after every verb that can change what the page shows, so a
 * browsing thread documents itself.
 *
 * Kept small and quiet on purpose:
 *  - ~800px-wide JPEG, downscaled inside Chrome (ShotOptions.maxWidth), so an
 *    auto shot costs tens of kilobytes, not a retina PNG.
 *  - Deduped per tab: the capture is hashed and compared with the previous
 *    auto shot for that tab. A press that changed nothing emits nothing. The
 *    hash lives in a file because every `cast` invocation is a new process.
 *  - Failure is silence: a screenshot that cannot be taken must never fail
 *    the action it was documenting.
 *
 * Opt-outs: `--no-shot` on any acting command, or persistently via the shared
 * config file (`cast browser shots off` → browser.auto_shots=false).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { screenshot } from "./actions.js";
import { browserHome } from "./profile.js";
import type { PageSession } from "./instance.js";
import { readSharedConfig, writeSharedConfig } from "../config/sharedConfig.js";
import { MAX_IMAGE_SIZE } from "../syncService.js";

export const AUTO_SHOT_MAX_WIDTH = 800;
const AUTO_SHOT_JPEG_QUALITY = 60;

// ---------------------------------------------------------- verb classification

// Verbs that can change what the page shows. Everything else — snapshot, text,
// find, console, network, tabs, eval, shot, wait — only reads, and an auto
// shot after a read would spam the thread with pictures of nothing happening.
const MUTATING = new Set([
  "open", "goto", "back", "forward", "reload",
  "click", "click-at", "press", "select", "upload",
]);

/**
 * Should this step trigger an auto shot? `type` only counts when it submits:
 * keystrokes into a field are mid-flow, the page that matters is the one the
 * submit produces.
 */
export function isMutatingStep(verb: string, args: string[] = []): boolean {
  if (verb === "type") return args.includes("--submit");
  return MUTATING.has(verb);
}

// ------------------------------------------------------------------- settings

function defaultConfigDir(): string {
  return process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast");
}

/** On unless the shared config says otherwise. */
export function autoShotsEnabled(configDir = defaultConfigDir()): boolean {
  return readSharedConfig(configDir).browser?.auto_shots !== false;
}

export function setAutoShots(on: boolean, configDir = defaultConfigDir()): void {
  const config = readSharedConfig(configDir);
  writeSharedConfig(configDir, { ...config, browser: { ...config.browser, auto_shots: on } });
}

// ------------------------------------------------------------------- dedupe

function hashStorePath(stateDir: string): string {
  return path.join(stateDir, "auto-shots.json");
}

function readHashes(stateDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(hashStorePath(stateDir), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * True when `hash` differs from the previous auto shot of this tab, recording
 * it for the next invocation. Last-write-wins under concurrent agents is fine:
 * the worst outcome is one extra screenshot, not a lost one.
 */
export function recordIfChanged(targetId: string, hash: string, stateDir = browserHome()): boolean {
  const map = readHashes(stateDir);
  if (map[targetId] === hash) return false;
  map[targetId] = hash;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(hashStorePath(stateDir), JSON.stringify(map));
  return true;
}

/** Drop hash entries for tabs that no longer exist, so the store cannot grow
 *  without bound. Piggybacks on callers that already know the live tab set. */
export function pruneHashes(liveTargetIds: Set<string>, stateDir = browserHome()): void {
  const map = readHashes(stateDir);
  const kept = Object.fromEntries(Object.entries(map).filter(([id]) => liveTargetIds.has(id)));
  if (Object.keys(kept).length !== Object.keys(map).length) {
    fs.writeFileSync(hashStorePath(stateDir), JSON.stringify(kept));
  }
}

// ------------------------------------------------------------------- capture

/**
 * The seam between this module and whatever drives the browser. `cast browser`
 * has more than one engine (the built-in CDP driver, agent-browser), and the
 * auto-shot policy — when to fire, dedupe, size, opt-outs — must be identical
 * across them. An engine supplies exactly two things: small JPEG bytes of the
 * visible page, and a stable key for the tab in whatever namespace it uses.
 */
export interface AutoShotSource {
  /** JPEG of the viewport, at most AUTO_SHOT_MAX_WIDTH pixels wide. */
  capture(): Promise<Buffer>;
  /** Stable per-tab key: the dedupe store is keyed by it. */
  tabKey: string;
}

/** The built-in CDP driver's source. */
export function cdpAutoShotSource(page: PageSession): AutoShotSource {
  return {
    tabKey: page.targetId,
    capture: () => screenshot(page, {
      format: "jpeg",
      quality: AUTO_SHOT_JPEG_QUALITY,
      maxWidth: AUTO_SHOT_MAX_WIDTH,
    }),
  };
}

/**
 * Capture a small screenshot of the tab if it visibly changed since the last
 * auto shot. Returns the written file's path, or null when the shot was
 * suppressed (opted out, unchanged page, or capture failed). Never throws —
 * a screenshot that cannot be taken must never fail the action it documents.
 *
 * `shotFlag` is commander's `--no-shot` value: false means the user opted out
 * of this one command; undefined/true mean no opinion.
 */
export async function maybeAutoShot(source: AutoShotSource, shotFlag?: boolean): Promise<string | null> {
  if (shotFlag === false || !autoShotsEnabled()) return null;
  try {
    const buf = await source.capture();
    if (buf.length > MAX_IMAGE_SIZE) return null; // never inline something sync would drop
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    if (!recordIfChanged(source.tabKey, hash)) return null;
    const out = path.join(os.tmpdir(), `cast-autoshot-${Date.now()}-${process.pid}.jpg`);
    fs.writeFileSync(out, buf);
    return out;
  } catch {
    return null;
  }
}
