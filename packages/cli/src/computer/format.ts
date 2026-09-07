/**
 * What `cast computer` prints when the agent did not ask for `--json`.
 *
 * Two shapes, and both exist to stop a specific misreading:
 *
 * 1. **The snapshot header.** The tree alone does not say which window it came
 *    from, how the screenshot's pixels relate to the coordinates an action
 *    takes, or whether the tree was cut short. An agent that guesses any of
 *    those clicks in the wrong place or acts on half a window, so the header
 *    states all three before the tree.
 *
 * 2. **The action sentence.** The first word is `completed` only when the
 *    helper actually read the change back; everything else is `attempted`.
 *    An action that reports success it did not verify is the failure this
 *    wording exists to prevent — most macOS input paths cannot be asserted, so
 *    "it ran" and "it worked" are genuinely different claims. The sentence
 *    then hands over the exact `get-app-state` command that would settle it,
 *    with the right window selector already filled in.
 */

import { formatBytes } from "../browser/profile.js";
import type {
  ComputerActionResult,
  ComputerActionVerification,
  ComputerListAppsResult,
  ComputerListWindowsResult,
  ComputerProviderCapabilities,
  ComputerSnapshotResult,
} from "./types.js";

/** The verb each helper method is called on the command line, for the sentence. */
const ACTION_LABEL: Record<string, string> = {
  click: "Click",
  performSecondaryAction: "Secondary action",
  scroll: "Scroll",
  typeText: "Type text",
  pressKey: "Press key",
  hotkey: "Hotkey",
  pasteText: "Paste text",
  setValue: "Set value",
};

const VERIFICATION_WORDS: Record<string, string> = {
  focusedText: "focused text",
  selection: "selection",
  value: "value",
  synthetic_input: "synthetic input",
  clipboard_paste: "clipboard paste",
  accessibility_action_unasserted: "accessibility action unasserted",
  provider_unavailable: "provider unavailable",
  readback_unsupported: "readback unsupported",
  window_changed: "window changed",
  value_mismatch: "value mismatch",
};

function words(key: string): string {
  return VERIFICATION_WORDS[key] ?? key.replace(/_/g, " ");
}

/** A number as short as it reads correctly: `2`, not `2.0`; `1.5`, not `1.50`. */
function trimNumber(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "?";
}

/** A selector safe to paste back into a shell. */
export function quoteSelector(value: string): string {
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface FollowUpTarget {
  /** What the agent typed after `--app`, so the printed command is one it can rerun. */
  app: string;
  windowId?: number | null;
  windowIndex?: number | null;
}

/** The `get-app-state` an agent should run next, with the window selector that
 *  still resolves — dropped entirely when the window moved out from under it. */
export function followUpCommand(target: FollowUpTarget): string {
  const parts = ["cast computer get-app-state", `--app ${quoteSelector(target.app)}`];
  if (typeof target.windowId === "number") parts.push(`--window-id ${target.windowId}`);
  else if (typeof target.windowIndex === "number") parts.push(`--window-index ${target.windowIndex}`);
  return parts.join(" ");
}

function screenshotLine(result: ComputerSnapshotResult): string {
  const status = result.screenshotStatus;
  if (status.state === "skipped") return "  Screenshot skipped (--no-screenshot)";
  if (status.state === "failed") return `  Screenshot failed (${status.code}): ${status.message}`;
  const shot = result.screenshot;
  if (!shot) return "  Screenshot captured but not returned";
  const bytes = shot.data ? Buffer.byteLength(shot.data, "base64") : null;
  const engine = status.metadata?.engine;
  const scale = trimNumber(shot.scale);
  const parts = [
    shot.format,
    bytes === null ? null : formatBytes(bytes),
    `${shot.width}x${shot.height}`,
    `scale ${scale}`,
  ].filter(Boolean);
  // The conversion is spelled out because getting it wrong on a retina display
  // clicks at twice the intended offset and reads as a broken tool.
  return `  Screenshot captured (${parts.join(", ")}; coordinate x/y = screenshot pixels / ${scale}${engine ? `, ${engine}` : ""})`;
}

function truncationLine(result: ComputerSnapshotResult): string {
  const t = result.snapshot.truncation;
  if (!t?.truncated) return "  Truncated: no";
  const why: string[] = [];
  if (t.maxDepthReached) why.push(`depth ${t.maxDepth ?? "cap"} reached`);
  else if (t.maxNodes) why.push(`${t.maxNodes} node cap`);
  return `  Truncated: yes${why.length ? ` (${why.join(", ")})` : ""} — the tree is partial, so an index may be missing rather than absent`;
}

/** The block above the tree: which window, how many elements, how the pixels map. */
function formatSnapshotHeader(result: ComputerSnapshotResult): string[] {
  const snapshot = result.snapshot;
  const app = snapshot.app;
  const win = snapshot.window;
  const id = typeof win.id === "number" ? `id:${win.id} ` : "";
  const at = typeof win.x === "number" && typeof win.y === "number" ? ` @ ${win.x},${win.y}` : "";
  const focused = typeof snapshot.focusedElementId === "number" ? `#${snapshot.focusedElementId}` : "none";
  return [
    `${app.name} (pid ${app.pid}${app.bundleId ? `, ${app.bundleId}` : ""})`,
    `  Window: ${id}"${win.title}" (${win.width}x${win.height}${at})`,
    `  Visible elements: ${snapshot.elementCount}  Focused: ${focused}  Coordinates: ${snapshot.coordinateSpace}`,
    truncationLine(result),
    screenshotLine(result),
  ];
}

/** Header, blank line, then the helper's tree (which carries its own envelope). */
export function formatSnapshot(result: ComputerSnapshotResult): string {
  return `${formatSnapshotHeader(result).join("\n")}\n\n${result.snapshot.treeText}`;
}

function verificationPhrase(verification: ComputerActionVerification | undefined): string {
  if (!verification) return "unverified (verification metadata unavailable)";
  return verification.state === "verified"
    ? `verified (${words(verification.property)})`
    : `unverified (${words(verification.reason)})`;
}

/**
 * One sentence for an action: what was attempted, by which path, whether it was
 * verified, and the command that would prove it.
 *
 * `window_changed` drops the window selector on purpose. The window the action
 * targeted is gone, so printing its id would hand the agent a selector that
 * resolves to nothing and reads as a second, unrelated failure.
 */
export function formatAction(method: string, appSelector: string, result: ComputerActionResult): string {
  const action = result.action;
  const verification = action?.verification;
  const verified = verification?.state === "verified";
  const label = ACTION_LABEL[method] ?? method;
  const via = action?.path ? ` via ${action.path}` : "";
  const windowChanged = verification?.state === "unverified" && verification.reason === "window_changed";
  const follow = followUpCommand({
    app: appSelector,
    windowId: windowChanged ? null : (action?.targetWindowId ?? result.snapshot.window.id),
    windowIndex: windowChanged ? null : action?.targetWindowIndex,
  });
  const sentences = [
    `${label} ${verified ? "completed" : "attempted"}${via}, ${verificationPhrase(verification)}; ${result.snapshot.elementCount} visible elements in current window.`,
    `Use \`${follow}\` to inspect.`,
  ];
  if (!verified) sentences.push("Inspect with the command above or use the --json result before assuming it worked.");
  return sentences.join(" ");
}

export function formatApps(result: ComputerListAppsResult): string {
  if (!result.apps.length) return "No running apps with a regular activation policy.";
  const width = Math.max(...result.apps.map((a) => a.name.length));
  return result.apps
    .map((a) => `${a.name.padEnd(width)}  ${a.bundleId ?? "(no bundle id)"}  pid ${a.pid}`)
    .join("\n");
}

export function formatWindows(result: ComputerListWindowsResult): string {
  const head = `${result.app.name} (pid ${result.app.pid}${result.app.bundleId ? `, ${result.app.bundleId}` : ""})`;
  if (!result.windows.length) {
    return `${head}\n  No visible windows. cast computer does not launch closed apps; open or restore one first.`;
  }
  const rows = result.windows.map((w) => {
    const id = typeof w.id === "number" ? `id:${w.id}` : "id:?";
    const at = typeof w.x === "number" && typeof w.y === "number" ? ` @ ${w.x},${w.y}` : "";
    const flags = [w.isMain ? "main" : null, w.isMinimized ? "minimized" : null, w.isOffscreen ? "offscreen" : null]
      .filter(Boolean)
      .join(", ");
    return `  [${w.index}] ${id} "${w.title}" (${w.width}x${w.height}${at})${flags ? ` — ${flags}` : ""}`;
  });
  return [head, ...rows].join("\n");
}

export function formatCapabilities(caps: ComputerProviderCapabilities): string {
  const on = (group: Record<string, boolean>) =>
    Object.entries(group)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ") || "none";
  return [
    `${caps.provider} ${caps.providerVersion} on ${caps.platform} (protocol ${caps.protocolVersion})`,
    `  Actions: ${on(caps.supports.actions)}`,
    `  Windows: ${on(caps.supports.windows)}`,
    `  Observation: ${on(caps.supports.observation)}`,
    // Nothing here focuses a window: only --restore-window raises, and it is an
    // observation flag rather than a verb an agent may call.
    `  Focus: no verb raises a window; pass --restore-window when the human's screen may move`,
  ].join("\n");
}
