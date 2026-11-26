// Headless-Chrome thumbnails for `cast publish`: the 1200x630 preview shot of a
// page's entry html, shared by plain publishes and motion pages (publishMotion.ts).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "./proc.js";
import { automationChromeBinary, keychainArgs } from "./workspace/chrome.js";

const THUMB_TIMEOUT_MS = 10_000;

/** The headless Chrome every codecast launcher uses: one the human's links can never reach (automationChromeBinary). */
export const findChrome = (): string | null => automationChromeBinary();

/** The headless command line for one thumbnail taken by `chrome`. Pure, so the
 * flag set is testable without spawning a browser. The throwaway profile dir
 * keeps the capture off the human's real profile (which a running Chrome holds
 * locked), and the keychain flags keep it off the macOS keychain
 * (keychainArgs). */
export function thumbArgs(chrome: string, entryHtmlAbsPath: string, outPng: string, profileDir: string, extraArgs: string[] = []): string[] {
  return [
    "--headless=new",
    `--screenshot=${outPng}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1200,630",
    "--hide-scrollbars",
    "--disable-gpu",
    "--no-first-run",
    ...keychainArgs(chrome),
    ...extraArgs,
    `file://${entryHtmlAbsPath}`,
  ];
}

/** A whole PNG: the signature up front and the IEND chunk closing it, so a
 * screenshot still being written never passes for a finished one. */
export function isCompletePng(bytes: Buffer): boolean {
  return bytes.length > 20 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.subarray(-8, -4).toString("latin1") === "IEND";
}

/** Headless-Chrome 1200x630 screenshot of a local html file → base64 png.
 * ANY failure (no Chrome, timeout, bad exit) returns null silently — a
 * thumbnail must never block or delay a publish beyond its timeout.
 *
 * The shot is taken the moment the file is whole, not when Chrome exits:
 * Chrome 154 writes the screenshot and then never quits, in every headless
 * mode, so waiting on its exit turned every capture into a timeout. Chrome is
 * killed with SIGKILL either way (SIGTERM is ignored while it starts under load). */
export async function captureThumb(entryHtmlAbsPath: string, opts: { extraArgs?: string[]; timeoutMs?: number } = {}): Promise<string | null> {
  try {
    const chrome = findChrome();
    if (!chrome) return null;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-thumb-"));
    const outPng = path.join(tmpDir, "thumb.png");
    const child = spawn(chrome, thumbArgs(chrome, entryHtmlAbsPath, outPng, path.join(tmpDir, "profile"), opts.extraArgs), { stdio: "ignore" });
    try {
      const deadline = Date.now() + (opts.timeoutMs ?? THUMB_TIMEOUT_MS);
      let exited = false;
      child.once("exit", () => { exited = true; });
      child.once("error", () => { exited = true; });
      while (Date.now() < deadline) {
        const bytes = fs.existsSync(outPng) ? fs.readFileSync(outPng) : null;
        if (bytes && isCompletePng(bytes)) return bytes.toString("base64");
        if (exited) return null;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}
