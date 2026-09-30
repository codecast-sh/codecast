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
import { formatAction, formatApps, formatCapabilities, formatSnapshot, formatWindows, jsonChanges } from "./format.js";
import { diffTrees, filterTree, formatDiff, resolveElement, type TreeFilter } from "./tree.js";
import { ensureScreenshotDir, rewriteScreenshotForJson, screenshotFileName, sweepScreenshots } from "./screenshotFile.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ComputerSetupDeps } from "./setup.js";
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
  | "setup"
  | "list-apps"
  | "list-windows"
  | "get-app-state"
  | "click"
  | "perform-secondary-action"
  | "scroll"
  | "drag"
  | "type-text"
  | "press-key"
  | "hotkey"
  | "paste-text"
  | "set-value"
  | "find"
  | "wait";

const ACTION_METHOD: Record<string, ComputerActionMethod> = {
  click: "click",
  "perform-secondary-action": "performSecondaryAction",
  scroll: "scroll",
  drag: "drag",
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
  yes?: boolean;
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
  /** `--element <query>`: a name or `#index`, resolved against a fresh tree. */
  element?: string;
  nth?: string;
  /** `drag`'s other end: a window-local point, an index, or a name. */
  toX?: string;
  toY?: string;
  toElementIndex?: string;
  toElement?: string;
  /** `click --mouse`: a real mouse click at the element's center, never AXPress. */
  mouse?: boolean;
  /** Tree filters for get-app-state, find and the tree an action returns. */
  find?: string;
  under?: string;
  fullResolution?: boolean;
  /** `get-app-state --diff`: only what changed since this window's last snapshot. */
  diff?: boolean;
  /** `wait`: the text to wait for, and whether to wait for it to go instead. */
  gone?: boolean;
  change?: boolean;
  timeout?: string;
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
  /** What `setup` talks to besides the permission api: the materialize step,
   *  the confirm, the clock, the Ctrl C. Production overrides none of it; a
   *  test overrides all of it and drives the flow without a Mac. */
  setup?: Partial<ComputerSetupDeps>;
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

/**
 * The observation flags. `restoreWindow` is the only raise in the feature.
 *
 * A snapshot captures by default and an action does not: an action already
 * says what it changed, and a window capture is hundreds of kilobytes an agent
 * rarely needs after every click. `--screenshot` asks for one.
 */
function observeParams(verb: ComputerVerb, o: ComputerOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const wantShot = verb in ACTION_METHOD ? o.screenshot === true : o.screenshot !== false && verb === "get-app-state";
  if (!wantShot) params.noScreenshot = true;
  else if (o.fullResolution) params.fullResolution = true;
  if (o.restoreWindow) params.restoreWindow = true;
  return params;
}

/** `--find` and `--under`, parsed. */
function treeFilter(o: ComputerOptions): TreeFilter {
  const filter: TreeFilter = {};
  if (o.find !== undefined) {
    if (!o.find.trim()) throw invalid("--find needs the text to look for");
    filter.find = o.find;
  }
  const under = intFlag("--under", o.under, 0, 100_000);
  if (under !== undefined) filter.under = under;
  return filter;
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
  const base = { ...targetParams(o), ...observeParams(verb, o) };
  switch (verb) {
    case "list-windows":
      return { app: base.app };
    case "get-app-state":
      return o.diff ? { ...base, diff: true } : base;
    case "find":
    case "wait":
      return base;
    case "click": {
      const params: Record<string, unknown> = { ...base, ...pointParams("click", o) };
      if (o.mouse) {
        if (params.elementIndex === undefined) throw invalid("--mouse clicks an element's center; pass --element or --element-index (a coordinate click is already a mouse click)");
        params.mouse = true;
      }
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
    case "drag": {
      const params: Record<string, unknown> = { ...base, ...pointParams("drag", o) };
      const hasToIndex = o.toElementIndex !== undefined;
      if (hasToIndex && (o.toX !== undefined || o.toY !== undefined)) throw invalid("use either --to-element-index or --to-x and --to-y for drag, not both");
      if (hasToIndex) params.toElementIndex = intFlag("--to-element-index", o.toElementIndex, 0, 100_000);
      else if (o.toX === undefined || o.toY === undefined) throw invalid("drag requires where to drop: --to-element, --to-element-index, or --to-x and --to-y together");
      else Object.assign(params, { toX: numberFlag("--to-x", o.toX, -1_000_000, 1_000_000), toY: numberFlag("--to-y", o.toY, -1_000_000, 1_000_000) });
      return params;
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

/**
 * Where a verb's output goes. A single command prints as it goes; a `do` step
 * collects its lines into the step's report and its pictures for the end, so
 * the same `execute` serves both.
 */
export interface ComputerSink {
  log(line: string): void;
  /** An absolute path to a picture for the conversation. */
  image(abs: string): void;
  /** Print the screenshot's report line (the single command) or stay quiet (a batch). */
  quietShots?: boolean;
}

export const consoleSink: ComputerSink = {
  log: (line) => console.log(line),
  image: (abs) => console.log(inlineImageMarker(abs)),
};

function printJson(sink: ComputerSink, body: Record<string, unknown>): void {
  sink.log(JSON.stringify({ ok: true, ...body }, null, 2));
}

/**
 * Put the capture in the conversation on the human path.
 *
 * `writeShotFile` downscales past the sync cap and prints the report line;
 * the marker is emitted only for a file this command just wrote, at an
 * absolute path, which is that module's stated contract.
 */
function emitScreenshot(result: ComputerSnapshotResult, o: ComputerOptions, sink: ComputerSink): void {
  const data = result.screenshot?.data;
  if (!data) return;
  try {
    const dir = ensureScreenshotDir();
    sweepScreenshots(dir);
    const file = path.join(dir, screenshotFileName(result.snapshot.id));
    const abs = writeShotFile(Buffer.from(data, "base64"), file, { inline: o.inline, quiet: sink.quietShots });
    // Same rule as the --json path: a window capture can hold anything that
    // was on screen, so it is readable by this uid and nobody else.
    fs.chmodSync(file, 0o600);
    if (abs) sink.image(abs);
  } catch (err) {
    // The tree is the answer; a picture that could not be written is a note,
    // not a failure.
    console.error(fmt.muted(`  screenshot not written: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** The `--json` body: the screenshot as a path, and what changed in place of
 *  the raw tree it was compared against. */
function jsonBody(result: ComputerSnapshotResult): Record<string, unknown> {
  const { baselineTreeText: _baseline, ...rest } = rewriteScreenshotForJson(result);
  const changes = jsonChanges(result);
  return (changes ? { ...rest, changes } : rest) as unknown as Record<string, unknown>;
}

function emitSnapshot(result: ComputerSnapshotResult, o: ComputerOptions, sink: ComputerSink): void {
  if (o.json) return printJson(sink, jsonBody(result));
  sink.log(formatSnapshot(result, treeFilter(o), !!o.diff));
  emitScreenshot(result, o, sink);
}

function emitAction(verb: ComputerVerb, result: ComputerActionResult, o: ComputerOptions, sink: ComputerSink): void {
  if (o.json) return printJson(sink, jsonBody(result));
  sink.log(formatAction(ACTION_METHOD[verb], o.app ?? "", result, treeFilter(o)));
  emitScreenshot(result, o, sink);
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

export async function createComputerClient(deps: ComputerRunDeps): Promise<ComputerClientLike> {
  return deps.createClient ? deps.createClient() : await defaultClient();
}

async function defaultPermissions(): Promise<ComputerPermissionApi> {
  return await import("./permissions.js");
}

/** Verbs that act on one element, and so accept `--element <query>`. */
const ELEMENT_VERBS = new Set<ComputerVerb>(["click", "perform-secondary-action", "scroll", "set-value", "drag"]);

/**
 * `--element <query>` to `--element-index`, against a tree read just now.
 *
 * The read is also what the helper validates the index against, so a name
 * resolves and acts inside one command with no stale-index window between.
 */
async function resolveElementOption(verb: ComputerVerb, o: ComputerOptions, client: ComputerClientLike): Promise<ComputerOptions> {
  if (o.element === undefined && o.toElement === undefined) return o;
  if (!ELEMENT_VERBS.has(verb)) throw invalid(`--element does not apply to ${verb}`);
  if (o.element !== undefined && o.elementIndex !== undefined) throw invalid("use either --element or --element-index, not both");
  if (o.toElement !== undefined && o.toElementIndex !== undefined) throw invalid("use either --to-element or --to-element-index, not both");
  const nth = intFlag("--nth", o.nth, 1, 1000);
  // One read serves both ends of a drag.
  let tree: string | undefined;
  const lookup = async (query: string, pick?: number): Promise<string> => {
    if (/^#?\d+$/.test(query.trim())) return String(resolveElement("", query));
    tree ??= (await client.getAppState({ ...targetParams(o), noScreenshot: true })).snapshot.treeText;
    return String(resolveElement(tree, query, pick));
  };
  const out: ComputerOptions = { ...o, element: undefined, toElement: undefined };
  if (o.element !== undefined) out.elementIndex = await lookup(o.element, nth);
  if (o.toElement !== undefined) out.toElementIndex = await lookup(o.toElement);
  return out;
}

/** Validate every flag before anything talks to the helper, with an element
 *  query standing in as an index so a bad chord still costs no launch. */
export function validateVerb(verb: ComputerVerb, o: ComputerOptions, deps: ComputerRunDeps): void {
  if (verb === "capabilities" || verb === "list-apps") return;
  treeFilter(o);
  if (verb === "wait") waitSpec(o);
  buildParams(
    verb,
    { ...o, ...(o.element !== undefined ? { elementIndex: "0" } : {}), ...(o.toElement !== undefined ? { toElementIndex: "0" } : {}) },
    deps,
  );
}

/** Run one verb against a connected client. Shared by the single command and
 *  every `do` step. */
export async function execute(
  verb: ComputerVerb,
  raw: ComputerOptions,
  client: ComputerClientLike,
  deps: ComputerRunDeps,
  sink: ComputerSink,
): Promise<void> {
  switch (verb) {
    case "capabilities": {
      const caps = await client.capabilities();
      if (raw.json) printJson(sink, caps as unknown as Record<string, unknown>);
      else sink.log(formatCapabilities(caps));
      return;
    }
    case "list-apps": {
      const result = await client.listApps();
      if (raw.json) printJson(sink, result as unknown as Record<string, unknown>);
      else sink.log(formatApps(result));
      return;
    }
    case "list-windows": {
      const result = await client.listWindows(buildParams(verb, raw, deps));
      if (raw.json) printJson(sink, result as unknown as Record<string, unknown>);
      else sink.log(formatWindows(result));
      return;
    }
    case "get-app-state":
      return emitSnapshot(await client.getAppState(buildParams(verb, raw, deps)), raw, sink);
    case "find":
      return runFind(raw, client, deps, sink);
    case "wait":
      return runWait(raw, client, deps, sink);
    default: {
      const method = ACTION_METHOD[verb];
      if (!method) throw invalid(`unknown verb '${verb}'`);
      const o = await resolveElementOption(verb, raw, client);
      emitAction(verb, await client.action(method, buildParams(verb, o, deps)), o, sink);
    }
  }
}

/** One entry point for every verb, so validation, error shape and exit code
 *  are decided in exactly one place. */
export async function runComputerVerb(verb: ComputerVerb, o: ComputerOptions, deps: ComputerRunDeps = {}): Promise<void> {
  try {
    if (verb === "permissions") return await runPermissions(o, deps);
    if (verb === "setup") return await runSetup(o, deps);
    // Flags are validated first, so a bad chord or an out-of-range number costs
    // neither a helper launch nor the client module it would be launched from.
    validateVerb(verb, o, deps);
    const client = await createComputerClient(deps);
    try {
      await execute(verb, o, client, deps, consoleSink);
    } finally {
      client.shutdown();
    }
  } catch (err) {
    fail(err, o, deps);
  }
}

/** `find <text>`: the matching elements and their ancestors, no screenshot. */
async function runFind(o: ComputerOptions, client: ComputerClientLike, deps: ComputerRunDeps, sink: ComputerSink): Promise<void> {
  const result = await client.getAppState(buildParams("find", o, deps));
  if (o.json) return printJson(sink, jsonBody(result));
  const win = result.snapshot.window;
  const cut = filterTree(result.snapshot.treeText, treeFilter(o));
  sink.log(`${result.snapshot.app.name} id:${win.id ?? "?"} "${win.title}"`);
  sink.log(cut ?? `Nothing matches '${o.find}'.`);
}

interface WaitSpec {
  text?: string;
  gone: boolean;
  change: boolean;
  timeoutMs: number;
}

function waitSpec(o: ComputerOptions): WaitSpec {
  const text = o.text?.trim() || undefined;
  if (!text && !o.change) throw invalid("wait needs --text <text> (add --gone to wait for it to disappear) or --change");
  if (text && o.change) throw invalid("use either --text or --change, not both");
  const seconds = numberFlag("--timeout", o.timeout, 0.1, 120) ?? 10;
  return { text, gone: !!o.gone, change: !!o.change, timeoutMs: seconds * 1000 };
}

const WAIT_POLL_MS = 250;
const WAIT_LINES = 12;

/**
 * Poll the tree until text appears, disappears, or anything changes.
 *
 * Apps update their tree on their own schedule: a sheet slides in, a search
 * fills a list. Without this an agent sleeps a guessed number of seconds and
 * snapshots, and either waits too long or reads the old state.
 */
async function runWait(o: ComputerOptions, client: ComputerClientLike, deps: ComputerRunDeps, sink: ComputerSink): Promise<void> {
  const spec = waitSpec(o);
  const params = buildParams("wait", o, deps);
  const started = Date.now();
  let first: string | undefined;
  for (;;) {
    const result = await client.getAppState(params);
    const tree = result.snapshot.treeText;
    const hits = spec.text ? filterTree(tree, { find: spec.text }) : null;
    first ??= tree;
    const met = spec.text ? (spec.gone ? hits === null : hits !== null) : tree !== first;
    const waited = ((Date.now() - started) / 1000).toFixed(1);
    if (met) {
      if (o.json) return printJson(sink, { waitedMs: Date.now() - started, ...jsonBody(result) });
      if (spec.change) sink.log(`Changed after ${waited}s.\n${formatDiff(diffTrees(first, tree)) ?? tree}`);
      else if (spec.gone) sink.log(`'${spec.text}' is gone after ${waited}s.`);
      else {
        // The matches and where they sit, not every line under them.
        const lines = (hits ?? "").split("\n");
        const shown = lines.length > WAIT_LINES ? [...lines.slice(0, WAIT_LINES), `… ${lines.length - WAIT_LINES} more (find prints them all)`] : lines;
        sink.log(`'${spec.text}' appeared after ${waited}s:\n${shown.join("\n")}`);
      }
      return;
    }
    if (Date.now() - started >= spec.timeoutMs) {
      const what = spec.text ? `'${spec.text}' did not ${spec.gone ? "disappear" : "appear"}` : "the window's tree did not change";
      throw new ComputerError("action_timeout", `${what} within ${spec.timeoutMs / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
}

/**
 * The grant flow. It is the only verb that both reads permissions and can put
 * a window on screen, so the raise lives behind its confirm and nowhere else
 * (design 11.2, 13; `focusRaise.guard.test.ts` holds the split).
 */
async function runSetup(o: ComputerOptions, deps: ComputerRunDeps): Promise<void> {
  const api = await (deps.permissions ?? defaultPermissions)();
  const { defaultSetupDeps, runComputerSetup } = await import("./setup.js");
  const isTty = deps.stdinIsTty ?? (() => !!process.stdin.isTTY);
  await runComputerSetup({ yes: !!o.yes }, { ...defaultSetupDeps(api, isTty), ...deps.setup });
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
  if (o.json) printJson(consoleSink, result as unknown as Record<string, unknown>);
  else for (const line of api.formatPermissionsReport(result)) console.log(line);
}
