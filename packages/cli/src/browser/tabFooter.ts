/**
 * Post-action footer for the engine path: the two lines the conversation view
 * reads off a `cast browser` row — the page URL on its own line, then the tab
 * identity from tabId.ts. The built-in driver prints both itself; the engine
 * passthrough prints only what agent-browser prints, which names tabs by a
 * per-session label (`t1`) that no browser-level CDP call can act on. Called
 * from cliEngine.ts passthrough() after tab-affecting verbs.
 */

import { fmt } from "../colors.js";
import { tabLine } from "./tabId.js";

export interface FooterTab {
  targetId: string;
  active?: boolean;
  url?: string;
}

/** Verbs after which the driven tab (or its page) may have changed. */
export const TAB_AFFECTING_VERBS = new Set([
  "open", "back", "forward", "reload", "click", "press", "type", "fill", "select", "batch", "tab",
]);

/** The lines to print, or [] when there is no active tab to name. */
export function tabFooterLines(tabs: FooterTab[]): string[] {
  const active = tabs.find((t) => t.active && t.targetId) ?? tabs.find((t) => t.targetId);
  if (!active) return [];
  const lines: string[] = [];
  if (active.url && /^https?:\/\//.test(active.url)) lines.push(`  ${active.url}`);
  lines.push(fmt.muted(`  ${tabLine(active.targetId)}`));
  return lines;
}

/**
 * Print the footer for a passthrough verb. `listTabs` is engine.ts
 * engineTabs() (its {tabId,targetId,active,url} rows fit FooterTab as-is).
 * Failures print nothing: the footer is a courtesy, never a reason to fail a
 * command that already succeeded.
 */
export function printTabFooter(engineVerb: string, listTabs: () => FooterTab[]): void {
  if (!TAB_AFFECTING_VERBS.has(engineVerb)) return;
  try {
    for (const line of tabFooterLines(listTabs())) console.log(line);
  } catch {
    /* courtesy only */
  }
}
