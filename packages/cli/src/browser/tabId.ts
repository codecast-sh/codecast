/**
 * The tab identity `cast browser` prints and the web parses back.
 *
 * One place, because two things must agree on it and neither can see the
 * other: every engine path (the built-in CDP driver, the agent-browser
 * adapter) prints it after acting on a tab, and the conversation view
 * (packages/web/lib/browserFocus.ts) reads it off the command row so "open
 * tab" can ask the daemon to raise that exact tab.
 *
 * It is the CDP target id, shortened — never an engine's own per-session
 * label (agent-browser's `t1`), which repeats across agents and means nothing
 * to a browser-level CDP call. The daemon matches it back by prefix
 * (focusHttp.ts matchTab), the same way `--tab` resolves.
 */

export const TAB_ID_CHARS = 8;

export function shortTabId(targetId: string): string {
  return targetId.slice(0, TAB_ID_CHARS);
}

/** The muted footer line after an action: `tab 4A2CDC7E — next: …`. */
export function tabLine(targetId: string, next?: string): string {
  return `tab ${shortTabId(targetId)}${next ? ` — ${next}` : ""}`;
}
