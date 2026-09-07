/**
 * Every `cast computer` failure, and the one recovery that fixes it.
 *
 * The recovery text lives HERE and nowhere else: the agent guidance snippet
 * (A6) points at this table instead of restating it, so an error and its
 * recovery can never drift apart. The rule every recovery encodes: never retry
 * the same command unchanged — read something fresh, or change the request.
 *
 * A helper error arrives as `{code, message}` on the wire and becomes a
 * ComputerError; a client-side failure (spawn, timeout, superseded queue)
 * raises the same class, so a caller has one shape to catch.
 */

import type { ComputerErrorCode } from "./types.js";

export class ComputerError extends Error {
  readonly code: ComputerErrorCode;
  constructor(code: ComputerErrorCode, message: string) {
    super(message);
    this.name = "ComputerError";
    this.code = code;
  }
  /** The flat `--json` envelope, `ok` first, matching the `cast app` convention. */
  toJSON(): { ok: false; code: ComputerErrorCode; message: string; recovery: string[] } {
    return { ok: false, code: this.code, message: this.message, recovery: recoveryFor(this.code) };
  }
}

const RECOVERY: Record<ComputerErrorCode, string[]> = {
  app_not_found: [
    "Run `cast computer list-apps` and retry with the exact bundle id.",
    "A web app such as Gmail is not an app selector: target the desktop browser that contains it.",
    "If the browser is not listed, open or focus it first.",
  ],
  app_blocked: ["Stop. Do not drive this app.", "Choose another target or ask the human to do it."],
  window_not_found: [
    "Run `cast computer list-windows --app <app>` and target a listed window.",
    "If the app is listed with no visible window, retry observation once with `--restore-window`.",
    "cast computer does not launch closed apps.",
  ],
  window_not_focused: [
    "Retry once with `--restore-window`.",
    "If the message says restore was already requested, stop retrying restore and prefer `set-value` or `perform-secondary-action`, which do not need focus.",
    "If the message says presses may already have been delivered, run `get-app-state` and check before retrying.",
  ],
  window_stale: [
    "Run `cast computer list-windows --app <app>` and choose a current selector.",
    "Then rerun `get-app-state` before acting.",
  ],
  provider_incompatible: [
    "Run `cast computer capabilities`.",
    "Update codecast; the CLI and the helper it materializes must come from the same release.",
  ],
  unsupported_capability: [
    "Run `cast computer capabilities` and choose a supported action.",
    "Or use a semantic alternative such as `set-value` or `click`.",
  ],
  permission_denied: [
    "Run `cast computer permissions` to read the grants; it reports and shows nothing on screen.",
    "To grant, ask the human first: `cast computer permissions --open-settings --id accessibility` takes the front.",
    "A token or peer failure means the helper belongs to another user or another launch: rerun the command, which relaunches it.",
  ],
  element_not_found: [
    "Run `cast computer get-app-state --app <app>` again and use an element index from the fresh tree.",
    "Never infer an index from `elementCount`.",
    "Never reuse an index after navigation, scrolling, a focus change or a delay.",
  ],
  element_not_clickable: [
    "Choose a parent or child that has a frame.",
    "Or use window-local coordinates taken from the latest screenshot.",
  ],
  action_not_supported: [
    "Read the element's `Secondary Actions` in a fresh snapshot and use one of those names.",
    "Or use `click` or `set-value`.",
  ],
  value_not_settable: [
    "Choose a settable element from a fresh snapshot.",
    "If none accepts a write, focus it and use keyboard input, then inspect the returned state.",
  ],
  invalid_argument: ["Fix the flags exactly as the message says.", "Do not retry unchanged."],
  action_timeout: [
    "Run `get-app-state` first so you know whether the UI changed.",
    "Then retry with a simpler semantic action, or with `--no-screenshot` if observation is slow.",
    "Do not repeat the same timed-out action blindly.",
  ],
  screenshot_failed: [
    "If the tree is enough, rerun with `--no-screenshot`.",
    "If the message names Screen Recording, `cast computer permissions --open-settings --id screenshots` opens the pane — it takes the front, so ask the human first.",
  ],
  accessibility_error: [
    "Run `cast computer capabilities`.",
    "If the message names Accessibility, `cast computer permissions --open-settings --id accessibility` opens the pane — it takes the front, so ask the human first.",
    "If it names the helper app, run `cast doctor`.",
    "Do not loop while availability is unchanged.",
  ],
};

const CODES = new Set(Object.keys(RECOVERY) as ComputerErrorCode[]);

export function recoveryFor(code: ComputerErrorCode): string[] {
  return RECOVERY[code] ?? RECOVERY.accessibility_error;
}

export function isComputerErrorCode(value: unknown): value is ComputerErrorCode {
  return typeof value === "string" && CODES.has(value as ComputerErrorCode);
}

/**
 * A helper's error object as a ComputerError.
 *
 * A helper from another release — or a corrupted line — can name a code this
 * CLI does not know. Mapping it to `accessibility_error` keeps the caller's
 * `catch` honest: an unknown code with no recovery reads as "the helper is not
 * what we expect", which is exactly what it is.
 */
export function computerErrorFromWire(error: unknown): ComputerError {
  const raw = (error ?? {}) as { code?: unknown; message?: unknown };
  const message = typeof raw.message === "string" && raw.message ? raw.message : "the computer helper failed without a message";
  if (!isComputerErrorCode(raw.code)) {
    const named = typeof raw.code === "string" && raw.code ? ` (helper reported an unknown code '${raw.code}')` : "";
    return new ComputerError("accessibility_error", `${message}${named}`);
  }
  return new ComputerError(raw.code, message);
}

/** Anything thrown on the client side, as a ComputerError. */
export function asComputerError(err: unknown, fallback: ComputerErrorCode = "accessibility_error"): ComputerError {
  if (err instanceof ComputerError) return err;
  return new ComputerError(fallback, err instanceof Error ? err.message : String(err));
}
