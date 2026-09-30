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
 *    "it ran" and "it worked" are genuinely different claims. Under it goes
 *    what the action changed in the window's tree, which is the evidence an
 *    unverified action is otherwise missing: "No change" says a press was
 *    ignored in the same breath as the attempt, where an agent used to spend a
 *    second full snapshot to find that out.
 */

import { formatBytes } from "../browser/profile.js";
import { diffTrees, filterTree, formatDiff, type TreeFilter } from "./tree.js";
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
  background_input: "sent to the app in the background",
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

/**
 * Header, blank line, then the tree: whole, cut down to what `filter` asks
 * for, or (for `--diff`) only what changed since this window's last snapshot.
 */
export function formatSnapshot(result: ComputerSnapshotResult, filter: TreeFilter = {}, diff = false): string {
  const header = formatSnapshotHeader(result).join("\n");
  return `${header}\n\n${treeBody(result, filter, diff)}`;
}

function treeBody(result: ComputerSnapshotResult, filter: TreeFilter, diff: boolean): string {
  const tree = result.snapshot.treeText;
  if (diff) {
    if (result.baselineTreeText === undefined) return `No earlier snapshot of this window to compare with; the whole tree:\n${tree}`;
    return formatDiff(diffTrees(result.baselineTreeText, tree)) ?? `The window changed substantially; the whole tree:\n${tree}`;
  }
  if (filter.find === undefined && filter.under === undefined) return tree;
  const cut = filterTree(tree, filter);
  if (cut !== null) return cut;
  return filter.under !== undefined && filter.find === undefined
    ? `No element ${filter.under} in this tree; indexes go stale, so read it again.`
    : `Nothing matches '${filter.find}'${filter.under !== undefined ? ` under ${filter.under}` : ""}.`;
}

function verificationPhrase(verification: ComputerActionVerification | undefined): string {
  if (!verification) return "unverified (verification metadata unavailable)";
  return verification.state === "verified"
    ? `verified (${words(verification.property)})`
    : `unverified (${words(verification.reason)})`;
}

/**
 * An action: one sentence saying what was attempted, by which path and whether
 * it was verified, then what it changed.
 *
 * `window_changed` means the window the action targeted is gone (a dialog
 * closed, a document window replaced itself), so a diff against it would be
 * noise: the sentence names the window the helper fell back to and prints its
 * whole tree, and the follow-up command drops the stale window selector.
 */
export function formatAction(method: string, appSelector: string, result: ComputerActionResult, filter: TreeFilter = {}): string {
  const action = result.action;
  const verification = action?.verification;
  const verified = verification?.state === "verified";
  const label = ACTION_LABEL[method] ?? method;
  const via = action?.path ? ` via ${action.path}${action.actionName && action.path === "accessibility" ? ` (${action.actionName})` : ""}` : "";
  const windowChanged = verification?.state === "unverified" && verification.reason === "window_changed";
  const sentence = `${label} ${verified ? "completed" : "attempted"}${via}, ${verificationPhrase(verification)}.`;
  const win = result.snapshot.window;
  if (windowChanged) {
    const follow = followUpCommand({ app: appSelector, windowId: null, windowIndex: null });
    return [
      sentence,
      `The target window is gone; this is now id:${win.id ?? "?"} "${win.title}". Next: \`${follow}\`.`,
      treeBody(result, filter, false),
    ].join("\n");
  }
  if (result.baselineTreeText === undefined) {
    // A helper from before the diff: say how to look instead.
    const follow = followUpCommand({ app: appSelector, windowId: action?.targetWindowId ?? win.id, windowIndex: action?.targetWindowIndex });
    return `${sentence} ${result.snapshot.elementCount} visible elements in current window. Use \`${follow}\` to inspect.`;
  }
  const body = filter.find !== undefined || filter.under !== undefined
    ? treeBody(result, filter, false)
    : (formatDiff(diffTrees(result.baselineTreeText, result.snapshot.treeText)) ??
      `The window changed substantially; the whole tree:\n${result.snapshot.treeText}`);
  return `${sentence}\n${body}`;
}

/** What `--json` says changed, in place of the raw baseline tree. */
export function jsonChanges(result: ComputerSnapshotResult): Record<string, unknown> | undefined {
  if (result.baselineTreeText === undefined) return undefined;
  const diff = diffTrees(result.baselineTreeText, result.snapshot.treeText);
  const line = (l: { index: number | null; body: string }) => (l.index === null ? l.body : `${l.index} ${l.body}`);
  return {
    added: diff.added.map(line),
    removed: diff.removed.map(line),
    focus: diff.focusAfter,
    focusChanged: diff.focusBefore !== diff.focusAfter,
  };
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
