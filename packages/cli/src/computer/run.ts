/**
 * Every `cast computer` verb: flags in, one helper request out, one answer
 * printed.
 *
 * This module is loaded by the command's action, never by the registration, so
 * `cast --help` and every unrelated verb pay nothing for the client, the
 * permission probe or the embedded helper bundle.
 *
 * Three rules shape what is here:
 *
 * **Validate before the helper sees it.** A bad chord, a coordinate that is not
 * a number, both `--text` and `--text-stdin`: each fails here with
 * `invalid_argument` and the exact fix. Sending it on would spend a spawn and a
 * round trip to learn the same thing, and the helper's message could not name
 * the flag the agent actually typed.
 *
 * **Secrets arrive on stdin.** `--text-stdin` and `--value-stdin` exist because
 * a password in argv is in the shell history and in every other user's `ps`
 * output for as long as the command runs.
 *
 * **No verb raises a window.** `--restore-window` is the one exception in the
 * whole feature; the client stamps that raise so the daemon's focus sentinel
 * spares it (design 11.2). Nothing else here may move the human's screen, and
 * `focusRaise.guard.test.ts` in this directory fails the build if it tries.
 */

import { fmt, icons } from "../colors.js";
import { readStdinBody } from "../sendBody.js";
import { inlineImageMarker } from "../inlineImage.js";
import { writeShotFile } from "../browser/shotFile.js";
import { asComputerError, ComputerError } from "./errors.js";
import { formatAction, formatApps, formatCapabilities, formatSnapshot, formatWindows } from "./format.js";
import { ensureScreenshotDir, rewriteScreenshotForJson, screenshotFileName, sweepScreenshots } from "./screenshotFile.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ComputerActionMethod,
  ComputerActionResult,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerPermissionId,
  ComputerProviderCapabilities,
  ComputerSnapshotResult,
} from "./types.js";

export type ComputerVerb =
  | "capabilities"
  | "permissions"
  | "list-apps"
  | "list-windows"
  | "get-app-state"
  | "click"
  | "perform-secondary-action"
  | "scroll"
  | "type-text"
  | "press-key"
  | "hotkey"
  | "paste-text"
  | "set-value";

const ACTION_METHOD: Record<string, ComputerActionMethod> = {
  click: "click",
  "perform-secondary-action": "performSecondaryAction",
  scroll: "scroll",
  "type-text": "typeText",
  "press-key": "pressKey",
  hotkey: "hotkey",
  "paste-text": "pasteText",
  "set-value": "setValue",
};

/** Commander's parsed flags, all still strings — parsing them is this file's job. */
export interface ComputerOptions {
  app?: string;
  windowId?: string;
  windowIndex?: string;
  /** `--no-screenshot` arrives as `screenshot: false`. */
  screenshot?: boolean;
  restoreWindow?: boolean;
  json?: boolean;
  /** `--no-inline` arrives as `inline: false`. */
  inline?: boolean;
  id?: string;
  reset?: boolean;
  openSettings?: boolean;
  elementIndex?: string;
  x?: string;
  y?: string;
  clickCount?: string;
  mouseButton?: string;
  modifiers?: string;
  action?: string;
  direction?: string;
  pages?: string;
  text?: string;
  textStdin?: boolean;
  key?: string;
  value?: string;
  valueStdin?: boolean;
}

/** What this file needs from the client. `ComputerClient` satisfies it, and a
 *  test double satisfies it without a socket, a helper or a Mac. */
export interface ComputerClientLike {
  capabilities(): Promise<ComputerProviderCapabilities>;
  listApps(): Promise<ComputerListAppsResult>;
  listWindows(params: unknown): Promise<ComputerListWindowsResult>;
  getAppState(params: unknown): Promise<ComputerSnapshotResult>;
  action(method: ComputerActionMethod, params: unknown): Promise<ComputerActionResult>;
  shutdown(): void;
}

export interface ComputerPermissionApi {
  getPermissionStatus: typeof import("./permissions.js").getPermissionStatus;
  readPermissionStatus: typeof import("./permissions.js").readPermissionStatus;
  openPermissionSettings: typeof import("./permissions.js").openPermissionSettings;
  resetPermissions: typeof import("./permissions.js").resetPermissions;
  formatPermissionsReport: typeof import("./permissions.js").formatPermissionsReport;
}

export interface ComputerRunDeps {
  createClient?: () => ComputerClientLike;
  permissions?: () => Promise<ComputerPermissionApi>;
  readStdin?: () => string;
  stdinIsTty?: () => boolean;
  /** Injected so a test can assert the exit code without ending the runner. */
  exit?: (code: number) => never;
}

// ── flag parsing ───────────────────────────────────────────────────────────

const MODIFIERS = new Set([
  "alt", "cmd", "cmdorctrl", "command", "commandorcontrol", "control", "ctrl", "meta", "option", "shift", "super", "win",
]);

function invalid(message: string): ComputerError {
  return new ComputerError("invalid_argument", message);
}

/**
 * Split a chord on `+`, treating a `+` with nothing before it as the key itself.
 *
 * `Cmd+A` is two parts, `+` is one part named `+`, and `Cmd++` is Cmd plus the
 * plus key. Without this a chord ending in `+` would silently parse as a
 * modifier with no key and press nothing.
 */
export function splitChord(spec: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const ch of spec) {
    if (ch !== "+") {
      current += ch;
      continue;
    }
    if (current === "") parts.push("+");
    else {
      parts.push(current);
      current = "";
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}

const isModifier = (part: string): boolean => MODIFIERS.has(part.trim().toLowerCase());

/** One key, no chord — except the literal `+`, which IS one key. */
export function validatePressKey(key: string): string {
  if (splitChord(key).length !== 1) {
    throw invalid("press-key accepts one key only, for example Return, Escape, Tab, or +. Use hotkey for modifier combinations.");
  }
  return key;
}

/** At least two parts, exactly one of which is not a modifier. */
export function validateHotkey(key: string): string {
  const parts = splitChord(key);
  const keys = parts.filter((part) => !isModifier(part));
  if (parts.length < 2 || keys.length !== 1) {
    throw invalid("hotkey requires a modifier and one key, for example CmdOrCtrl+A. Use press-key for a single key.");
  }
  return key;
}

/**
 * Modifiers only, at most four.
 *
 * A chord is one flag on the click rather than a modifier-down command and a
 * modifier-up command: an agent interrupted between the two would leave a
 * modifier logically held down for the human.
 */
export function validateModifiers(spec: string): string {
  const parts = splitChord(spec);
  if (!parts.length || parts.length > 4 || parts.some((part) => !isModifier(part))) {
    throw invalid("click modifiers accept modifier keys only, for example CmdOrCtrl or CmdOrCtrl+Shift.");
  }
  return spec;
}

/** An integer flag, bounded before any conversion so `1e300` fails as a flag
 *  rather than trapping downstream. */
function intFlag(flag: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw.trim())) throw invalid(`${flag} must be an integer between ${min} and ${max}`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${flag} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function numberFlag(flag: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(raw.trim())) throw invalid(`${flag} must be a number between ${min} and ${max}`);
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < min || value > max) throw invalid(`${flag} must be a number between ${min} and ${max}`);
  return value;
}

function oneOf(flag: string, raw: string | undefined, allowed: string[]): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (!allowed.includes(value)) throw invalid(`${flag} must be one of ${allowed.join(", ")}`);
  return value;
}

/** The app and window selector every targeted verb shares. */
function targetParams(o: ComputerOptions): Record<string, unknown> {
  const app = (o.app ?? "").trim();
  if (!app) throw invalid("--app is required: a bundle id (com.apple.TextEdit), an app name (TextEdit), or pid:1234");
  if (o.windowId !== undefined && o.windowIndex !== undefined) {
    throw invalid("use either --window-id or --window-index, not both");
  }
  const params: Record<string, unknown> = { app };
  const windowId = intFlag("--window-id", o.windowId, 0, Number.MAX_SAFE_INTEGER);
  const windowIndex = intFlag("--window-index", o.windowIndex, 0, 4096);
  if (windowId !== undefined) params.windowId = windowId;
  if (windowIndex !== undefined) params.windowIndex = windowIndex;
  return params;
}

/** The observation flags. `restoreWindow` is the only raise in the feature. */
function observeParams(o: ComputerOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (o.screenshot === false) params.noScreenshot = true;
  if (o.restoreWindow) params.restoreWindow = true;
  return params;
}

/** An element index or a coordinate pair, and never both — they name different
 *  things, and guessing which one the agent meant is how a click lands
 *  somewhere nobody asked for. */
function pointParams(verb: string, o: ComputerOptions): Record<string, unknown> {
  const hasIndex = o.elementIndex !== undefined;
  const hasCoords = o.x !== undefined || o.y !== undefined;
  if (hasIndex && hasCoords) throw invalid(`use either --element-index or --x and --y for ${verb}, not both`);
  if (hasIndex) return { elementIndex: intFlag("--element-index", o.elementIndex, 0, 100_000) };
  if (o.x === undefined || o.y === undefined) {
    throw invalid(`${verb} requires --element-index, or --x and --y together (window-local coordinates)`);
  }
  return { x: numberFlag("--x", o.x, -1_000_000, 1_000_000), y: numberFlag("--y", o.y, -1_000_000, 1_000_000) };
}

/**
 * The text or value payload, from the flag or from stdin.
 *
 * Empty stdin is refused for text and accepted for a value, because typing
 * nothing is a mistake while clearing a field is a real action.
 */
function payload(kind: "text" | "value", verb: string, o: ComputerOptions, deps: ComputerRunDeps): string {
  const literal = kind === "text" ? o.text : o.value;
  const fromStdin = kind === "text" ? o.textStdin : o.valueStdin;
  if (literal !== undefined && fromStdin) throw invalid(`use either --${kind} or --${kind}-stdin, not both`);
  if (literal !== undefined) return literal;
  if (!fromStdin) throw invalid(`${verb} requires --${kind} or --${kind}-stdin (stdin keeps secrets out of argv)`);
  const isTty = deps.stdinIsTty ?? (() => !!process.stdin.isTTY);
  if (isTty()) throw invalid("stdin payload requested but stdin is a terminal");
  const body = (deps.readStdin ?? readStdinBody)();
  if (kind === "text" && body === "") throw invalid(`--text-stdin received no input; ${verb} has nothing to send`);
  return body;
}

/** Flags to the helper's params, mechanically. Exported so a test can assert
 *  the mapping without a helper. */
export function buildParams(verb: ComputerVerb, o: ComputerOptions, deps: ComputerRunDeps = {}): Record<string, unknown> {
  const base = { ...targetParams(o), ...observeParams(o) };
  switch (verb) {
    case "list-windows":
      return { app: base.app };
    case "get-app-state":
      return base;
    case "click": {
      const params: Record<string, unknown> = { ...base, ...pointParams("click", o) };
      const clickCount = intFlag("--click-count", o.clickCount, 1, 3);
      if (clickCount !== undefined) params.clickCount = clickCount;
      const mouseButton = oneOf("--mouse-button", o.mouseButton, ["left", "right", "middle"]);
      if (mouseButton) params.mouseButton = mouseButton;
      if (o.modifiers !== undefined) params.modifiers = validateModifiers(o.modifiers);
      return params;
    }
    case "perform-secondary-action": {
      const action = (o.action ?? "").trim();
      if (!action) throw invalid("perform-secondary-action requires --action, named exactly as the element's Secondary Actions list it");
      return { ...base, elementIndex: intFlag("--element-index", require1(o.elementIndex, "--element-index"), 0, 100_000), action };
    }
    case "scroll": {
      const direction = oneOf("--direction", require1(o.direction, "--direction"), ["up", "down", "left", "right"]);
      const params: Record<string, unknown> = { ...base, ...pointParams("scroll", o), direction };
      const pages = numberFlag("--pages", o.pages, 0.1, 100);
      if (pages !== undefined) params.pages = pages;
      return params;
    }
    case "type-text":
      return { ...base, text: payload("text", "type-text", o, deps) };
    case "paste-text":
      return { ...base, text: payload("text", "paste-text", o, deps) };
    case "press-key":
      return { ...base, key: validatePressKey(require1(o.key, "--key")) };
    case "hotkey":
      return { ...base, key: validateHotkey(require1(o.key, "--key")) };
    case "set-value":
      return {
        ...base,
        elementIndex: intFlag("--element-index", require1(o.elementIndex, "--element-index"), 0, 100_000),
        value: payload("value", "set-value", o, deps),
      };
    default:
      throw invalid(`unknown verb '${verb}'`);
  }
}

function require1(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") throw invalid(`${flag} is required`);
  return value;
}

// ── output ─────────────────────────────────────────────────────────────────

function printJson(body: Record<string, unknown>): void {
  console.log(JSON.stringify({ ok: true, ...body }, null, 2));
}

/**
 * Put the capture in the conversation on the human path.
 *
 * `writeShotFile` downscales past the sync cap and prints the report line;
 * the marker is emitted only for a file this command just wrote, at an
 * absolute path, which is that module's stated contract.
 */
function emitScreenshot(result: ComputerSnapshotResult, o: ComputerOptions): void {
  const data = result.screenshot?.data;
  if (!data) return;
  try {
    const dir = ensureScreenshotDir();
    sweepScreenshots(dir);
    const file = path.join(dir, screenshotFileName(result.snapshot.id));
    const abs = writeShotFile(Buffer.from(data, "base64"), file, { inline: o.inline });
    // Same rule as the --json path: a window capture can hold anything that
    // was on screen, so it is readable by this uid and nobody else.
    fs.chmodSync(file, 0o600);
    if (abs) console.log(inlineImageMarker(abs));
  } catch (err) {
    // The tree is the answer; a picture that could not be written is a note,
    // not a failure.
    console.error(fmt.muted(`  screenshot not written: ${err instanceof Error ? err.message : String(err)}`));
  }
}

function emitSnapshot(result: ComputerSnapshotResult, o: ComputerOptions): void {
  if (o.json) {
    printJson(rewriteScreenshotForJson(result) as unknown as Record<string, unknown>);
    return;
  }
  console.log(formatSnapshot(result));
  emitScreenshot(result, o);
}

function emitAction(verb: ComputerVerb, result: ComputerActionResult, o: ComputerOptions): void {
  if (o.json) {
    printJson(rewriteScreenshotForJson(result) as unknown as Record<string, unknown>);
    return;
  }
  console.log(formatAction(ACTION_METHOD[verb], o.app ?? "", result));
  emitScreenshot(result, o);
}

/**
 * How a failure reaches the agent: the flat envelope with `ok` first under
 * `--json`, the `✗ message` plus muted recovery lines otherwise.
 *
 * Both exit 1. The code an agent branches on is the `code` field and the
 * recovery text, not the exit status — sixteen exit codes would be a second
 * vocabulary saying less than the first.
 */
function fail(err: unknown, o: ComputerOptions, deps: ComputerRunDeps): never {
  const error = asComputerError(err);
  if (o.json) console.log(JSON.stringify(error.toJSON(), null, 2));
  else {
    console.error(`${fmt.error(icons.cross)} ${error.message}`);
    for (const line of error.toJSON().recovery) console.error(`  ${fmt.muted(line)}`);
  }
  return (deps.exit ?? process.exit)(1) as never;
}

// ── verbs ──────────────────────────────────────────────────────────────────

async function defaultClient(): Promise<ComputerClientLike> {
  // The version is what makes the providerVersion handshake meaningful: a
  // helper left over from the previous release is relaunched rather than
  // silently driving last release's renderer.
  //
  // It is claimed only by a CLI that carries a helper of its own. A CLI with no
  // embedded payload adopts whatever is installed at the fixed path, and
  // holding that bundle to this CLI's version would terminate a working helper
  // and relaunch the very same bundle, which reports the very same version — a
  // refusal loop rather than a mismatch (ct-49672). The protocol check is the
  // real compatibility gate, and it stays unconditional.
  const [{ ComputerClient }, { getVersion }, { computerHelperTar }] = await Promise.all([
    import("./client.js"),
    import("../update.js"),
    import("./helperPayload.js"),
  ]);
  return new ComputerClient({ version: computerHelperTar() ? getVersion() : undefined });
}

async function defaultPermissions(): Promise<ComputerPermissionApi> {
  return await import("./permissions.js");
}

/** One entry point for every verb, so validation, error shape and exit code
 *  are decided in exactly one place. */
export async function runComputerVerb(verb: ComputerVerb, o: ComputerOptions, deps: ComputerRunDeps = {}): Promise<void> {
  try {
    if (verb === "permissions") return await runPermissions(o, deps);
    // Flags are validated first, so a bad chord or an out-of-range number costs
    // neither a helper launch nor the client module it would be launched from.
    const params = verb === "capabilities" || verb === "list-apps" ? {} : buildParams(verb, o, deps);
    const client = deps.createClient ? deps.createClient() : await defaultClient();
    try {
      switch (verb) {
        case "capabilities": {
          const caps = await client.capabilities();
          if (o.json) printJson(caps as unknown as Record<string, unknown>);
          else console.log(formatCapabilities(caps));
          return;
        }
        case "list-apps": {
          const result = await client.listApps();
          if (o.json) printJson(result as unknown as Record<string, unknown>);
          else console.log(formatApps(result));
          return;
        }
        case "list-windows": {
          const result = await client.listWindows(params);
          if (o.json) printJson(result as unknown as Record<string, unknown>);
          else console.log(formatWindows(result));
          return;
        }
        case "get-app-state": {
          emitSnapshot(await client.getAppState(params), o);
          return;
        }
        default: {
          const method = ACTION_METHOD[verb];
          if (!method) throw invalid(`unknown verb '${verb}'`);
          emitAction(verb, await client.action(method, params), o);
          return;
        }
      }
    } finally {
      client.shutdown();
    }
  } catch (err) {
    fail(err, o, deps);
  }
}

async function runPermissions(o: ComputerOptions, deps: ComputerRunDeps): Promise<void> {
  const api = await (deps.permissions ?? defaultPermissions)();
  const id = o.id?.trim().toLowerCase();
  if (id !== undefined && id !== "accessibility" && id !== "screenshots") {
    throw invalid('--id must be "accessibility" or "screenshots"');
  }
  // Why: the bare read is a diagnostic six error recoveries send an agent to,
  // so it must not take the human's screen; only --open-settings raises
  // (ct-49667, design section 11.2 and 13).
  const permissionId = id as ComputerPermissionId | undefined;
  const result = o.reset
    ? await api.resetPermissions()
    : o.openSettings
      ? await api.openPermissionSettings(permissionId)
      : await api.readPermissionStatus(permissionId);
  if (o.json) printJson(result as unknown as Record<string, unknown>);
  else for (const line of api.formatPermissionsReport(result)) console.log(line);
}
