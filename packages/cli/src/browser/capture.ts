/**
 * Automatic failure context for browser steps.
 *
 * When a step fails — a wait times out, a click misses, an eval throws — the
 * useful evidence is on the page: what the console said, which requests failed,
 * what the screen actually showed. An agent rarely thinks to ask for those
 * before its turn ends, so the human gets a bare error and has to send the
 * agent back. This module gathers the trio automatically at the moment of
 * failure and prints it as one compact block, with the screenshot going through
 * the inline image marker so it renders in the thread.
 *
 * Everything here degrades rather than compounds: a failure while gathering
 * context must never obscure the original failure, so every capture path is
 * bounded by a deadline and collapses to a one-line note when the page cannot
 * answer.
 *
 * Two engines drive `cast browser` — the built-in CDP driver and the
 * agent-browser engine — and both report failures through the ONE function
 * here. What differs is only where the evidence comes from, so that is the
 * only thing that is pluggable: a `FailureSource` yields a `Recording` and a
 * screenshot, and everything downstream (classification, caps, formatting,
 * the inline marker) is shared. `pageSource` reads the in-page recorder over
 * CDP; `engineSource` asks the engine's console/errors/network verbs and
 * normalises them into the same `Recording` shape.
 *
 * Opt-out: `--no-capture` on a command for one invocation, or persistently with
 * `cast config browser_capture off`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PageSession } from "./instance.js";
import { readRecording, type Recording } from "./observe.js";
import { screenshot } from "./actions.js";
import { runEngine, runEngineJson, type EngineOptions } from "./engine.js";
import { downscaleWithSips } from "../imageCommand.js";
import { inlineImageMarker } from "../inlineImage.js";
import { MAX_IMAGE_SIZE } from "../syncService.js";
import { fmt } from "../colors.js";

// Bounds. The block lands in a conversation, not a log file: enough entries to
// name the breakage, few enough that the error stays visible above it.
export const CAPTURE_MAX_CONSOLE = 8;
export const CAPTURE_MAX_NETWORK = 6;
export const CAPTURE_MAX_LINE = 220;
/** Ceiling on the whole gather — a failing step must not double its own cost. */
const CAPTURE_DEADLINE_MS = 8000;

/**
 * What a failure message says about whether the page can still be asked.
 *
 * - "capturable": the page is alive; the failure is about page state (timeout,
 *   missing element, eval throw, navigation error). Full capture.
 * - "tab-wedged": the renderer is not answering, so console/network reads
 *   (which need Runtime.evaluate) would hang; a screenshot may still work.
 * - "browser-gone": the connection or browser is dead; nothing can be asked.
 * - "usage": the command was malformed before it touched the page; page
 *   evidence would be noise.
 */
export type FailureKind = "capturable" | "tab-wedged" | "browser-gone" | "usage";

export function classifyFailure(message: string): FailureKind {
  if (
    /CDP connection closed|CDP connection is not open|no managed browser is running|not answering CDP|CDP endpoint on port|CDP connect timed out/i.test(
      message,
    )
  ) {
    return "browser-gone";
  }
  // TabUnresponsive's message shape ("tab xxxxxxxx did not respond (…)").
  if (/did not respond \(/.test(message)) return "tab-wedged";
  if (
    /is not a ref\b|needs a (ref|url|key|value)|needs some text|unknown (step|size|viewport)|no such file|no steps given/.test(
      message,
    )
  ) {
    return "usage";
  }
  return "capturable";
}

export interface FailureContextText {
  /** Plain-text lines of the block body (no colors — callers style them). */
  lines: string[];
  /** Whether anything actionable was recorded (an error or a failed request). */
  hasSignal: boolean;
}

// One entry, one line: recorder text can carry a stack (fetch errors keep
// `err.stack`), and a stack in the block would bury the entries under it.
const clip = (raw: string): string => {
  const s = raw.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return s.length > CAPTURE_MAX_LINE ? `${s.slice(0, CAPTURE_MAX_LINE)}…` : s;
};
const stamp = (t: number): string => `+${(t / 1000).toFixed(1)}s`;

/**
 * Render a recording as the bounded body of the failure block: console errors
 * and warnings (uncaught errors included), then failed requests, both newest
 * first so the entries nearest the failure lead.
 */
export function formatFailureContext(rec: Recording): FailureContextText {
  const lines: string[] = [];

  if (!rec.armed) {
    return { lines: ["console/network unavailable (the recorder was not installed on this page)"], hasSignal: false };
  }

  const consoleHits = [
    ...rec.console.filter((c) => c.level === "error" || c.level === "warn").map((c) => ({
      t: c.t,
      line: `${stamp(c.t)} ${c.level === "error" ? "ERR" : "WRN"} ${c.text}`,
    })),
    ...rec.errors.map((e) => ({ t: e.t, line: `${stamp(e.t)} UNCAUGHT ${e.text}` })),
  ].sort((a, b) => b.t - a.t);

  if (consoleHits.length) {
    lines.push("console errors (newest first):");
    for (const h of consoleHits.slice(0, CAPTURE_MAX_CONSOLE)) lines.push(`  ${clip(h.line)}`);
    if (consoleHits.length > CAPTURE_MAX_CONSOLE) lines.push(`  (… ${consoleHits.length - CAPTURE_MAX_CONSOLE} more)`);
  }

  const failed = rec.network
    .filter((r) => r.error || r.status === 0 || (r.status !== null && r.status >= 400))
    .sort((a, b) => b.t - a.t);

  if (failed.length) {
    lines.push("failed requests (newest first):");
    for (const r of failed.slice(0, CAPTURE_MAX_NETWORK)) {
      const status = r.error || r.status === 0 ? "ERR" : String(r.status);
      lines.push(`  ${clip(`${status.padStart(3)} ${r.method.padEnd(6)} ${String(r.ms).padStart(5)}ms ${r.url}${r.error ? ` ${r.error}` : ""}`)}`);
    }
    if (failed.length > CAPTURE_MAX_NETWORK) lines.push(`  (… ${failed.length - CAPTURE_MAX_NETWORK} more)`);
  }

  const hasSignal = consoleHits.length > 0 || failed.length > 0;
  if (!hasSignal) lines.push("no console errors or failed requests recorded");
  return { lines, hasSignal };
}

/** Persistent opt-out, read from the same config file `cast config` writes. */
export function captureConfigOff(
  configDir = process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast"),
): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf-8"));
    return cfg.browser_capture === "off";
  } catch {
    return false;
  }
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`capture exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, bomb]);
  } finally {
    clearTimeout(timer!);
  }
}

export interface CaptureOptions {
  /** Set by `--no-capture`. */
  disabled?: boolean;
  /** Test override for where config.json lives. */
  configDir?: string;
}

/**
 * Where the evidence comes from. The two engines differ only here; the block
 * itself is built the same way from whichever source is live.
 */
export interface FailureSource {
  recording(): Promise<Recording>;
  screenshot(): Promise<Buffer>;
}

/** The built-in driver: an attached tab, read over CDP. */
export function pageSource(page: PageSession): FailureSource {
  return {
    recording: () => readRecording(page),
    screenshot: () => screenshot(page),
  };
}

/**
 * The agent-browser engine: its own buffers, asked for as JSON and mapped onto
 * the recorder's `Recording` shape so the same formatter reads both. The
 * engine timestamps requests but not console lines, so console entries get an
 * increasing pseudo-time that preserves their order; only the relative order
 * (newest first) matters to the block.
 */
export function engineSource(opts: EngineOptions = {}): FailureSource {
  const quiet = { ...opts, inherit: false };
  return {
    recording: async () => {
      const [con, err, net] = await Promise.all([
        Promise.resolve().then(() => runEngineJson<{ messages?: Array<{ type: string; text: string }> }>(["console"], quiet)).catch(() => null),
        Promise.resolve().then(() => runEngineJson<{ errors?: Array<{ text: string; url?: string | null; line?: number }> }>(["errors"], quiet)).catch(() => null),
        Promise.resolve().then(() => runEngineJson<{ requests?: Array<Record<string, any>> }>(["network", "requests"], quiet)).catch(() => null),
      ]);
      if (!con && !err && !net) return { console: [], network: [], errors: [], armed: false, late: true, dialogs: [] };
      const messages = con?.messages ?? [];
      const errors = err?.errors ?? [];
      const requests = net?.requests ?? [];
      const t0 = requests.reduce((m, r) => (typeof r.timestamp === "number" && r.timestamp < m ? r.timestamp : m), Infinity);
      const base = Number.isFinite(t0) ? t0 : 0;
      return {
        armed: true,
        late: false,
        dialogs: [],
        console: messages.map((m, i) => ({
          t: i,
          // The engine says "warning" where the recorder says "warn".
          level: m.type === "warning" ? "warn" : m.type,
          text: m.text,
        })),
        errors: errors.map((e, i) => ({
          t: messages.length + i,
          text: e.text + (e.url ? ` @ ${e.url}:${e.line ?? 0}` : ""),
          stack: null,
        })),
        network: requests.map((r) => ({
          t: typeof r.timestamp === "number" ? r.timestamp - base : 0,
          ms: 0,
          method: r.method ?? "GET",
          url: String(r.url ?? "").slice(0, 500),
          // A request the engine records with no status at all never got a
          // response — the transport failed. Match the recorder's convention
          // (status 0 + error) so the formatter marks it ERR.
          status: typeof r.status === "number" ? r.status : 0,
          kind: String(r.resourceType ?? "resource").toLowerCase(),
          ...(typeof r.status === "number" ? {} : { error: r.errorText ?? r.failure ?? "no response" }),
        })),
      };
    },
    screenshot: async () => {
      const out = path.join(os.tmpdir(), `cast-fail-engine-${Date.now()}.png`);
      const res = runEngine(["screenshot", out], quiet);
      if (res.status !== 0 || !fs.existsSync(out)) throw new Error("engine screenshot failed");
      const buf = fs.readFileSync(out);
      fs.unlinkSync(out);
      return buf;
    },
  };
}

/**
 * Print the failure block for a failed step: bounded console errors, failed
 * requests, and a screenshot inlined into the thread. Pass `source` as null
 * when the failure happened before a tab was attached — the block degrades to
 * a one-line note where a note is warranted, and to silence where it is not.
 *
 * Never throws: the original failure is the story, and this is a footnote.
 */
export async function emitFailureBlock(
  source: FailureSource | null,
  failureMessage: string,
  opts: CaptureOptions = {},
): Promise<void> {
  try {
    if (opts.disabled || captureConfigOff(opts.configDir)) return;
    const kind = classifyFailure(failureMessage);
    if (kind === "usage" || kind === "browser-gone") return;
    if (!source) {
      console.log(fmt.muted("  (no failure context: the tab could not be reached)"));
      return;
    }

    console.log(fmt.muted("── failure context ─────────────────────────────"));

    if (kind === "tab-wedged") {
      // Runtime.evaluate would hang on a blocked renderer, so skip the
      // recorder reads; the compositor can often still produce a screenshot.
      console.log(fmt.muted("console/network unavailable (the tab is not answering)"));
    } else {
      const rec = await withDeadline(source.recording(), CAPTURE_DEADLINE_MS);
      for (const line of formatFailureContext(rec).lines) console.log(line);
    }

    await emitScreenshot(source);
  } catch (err) {
    console.log(fmt.muted(`  (failure context could not be gathered: ${(err as Error).message})`));
  }
}

/** The built-in driver's entry point: same block, evidence read from the tab. */
export function emitFailureContext(
  page: PageSession | null,
  failureMessage: string,
  opts: CaptureOptions = {},
): Promise<void> {
  return emitFailureBlock(page ? pageSource(page) : null, failureMessage, opts);
}

async function emitScreenshot(source: FailureSource): Promise<void> {
  try {
    const buf = await withDeadline(source.screenshot(), CAPTURE_DEADLINE_MS);
    let bytes = buf;
    if (bytes.length > MAX_IMAGE_SIZE) {
      const smaller = downscaleWithSips(bytes, "image/png");
      if (smaller && smaller.length < bytes.length) bytes = smaller;
    }
    const out = path.join(os.tmpdir(), `cast-fail-${Date.now()}.png`);
    fs.writeFileSync(out, bytes);
    console.log(fmt.muted(`screenshot: ${out}`));
    if (bytes.length <= MAX_IMAGE_SIZE) console.log(inlineImageMarker(out));
  } catch {
    console.log(fmt.muted("  (screenshot could not be taken)"));
  }
}
