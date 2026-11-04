// What the issue page needs from the list it was opened from: the order the
// person was walking (so j and k on the page move to the next issue in it),
// the list's address to go back to with its filters, and the row that was
// focused (so going back lands on it). Per window, in memory: a page opened
// cold walks the store's newest-first order instead.
import { OPS_HOME, opsHref } from "./opsPaths";

let order: string[] = [];
let back: string | null = null;
let focused: string | null = null;

export function rememberIssueList(ids: string[], href: string): void {
  order = ids;
  back = href;
}

export function rememberIssueFocus(id: string | null): void {
  focused = id;
}

export function issueListOrder(): string[] {
  return order;
}

export function issueListBack(): string | null {
  return back;
}

export function issueListFocus(): string | null {
  return focused;
}

/** The issue `step` places from `id` in the remembered order (or the fallback), or null at either end. */
export function issueStep(id: string, step: 1 | -1, fallback: string[]): string | null {
  const list = order.includes(id) ? order : fallback;
  const i = list.indexOf(id);
  if (i < 0) return list[0] ?? null;
  return list[i + step] ?? null;
}

/** Where an issue was opened from: the home's list (when it holds this issue) or the Issues tab, with its filters. */
export function issueOrigin(id?: string): { label: string; href: string } {
  const back = issueListBack();
  const fromHome = !!back && (back === OPS_HOME || back.startsWith(`${OPS_HOME}?`));
  if (fromHome && (!id || issueListOrder().includes(id))) return { label: "Overview", href: back! };
  if (fromHome) return { label: "Issues", href: opsHref.tab("issues") };
  return { label: "Issues", href: back ?? opsHref.tab("issues") };
}

/** The Issues list searched for a metric part's message (its type prefix dropped), over every status: where an unnamed cause is looked up. */
export function causeSearchHref(key: string): string {
  const message = key.replace(/^[^:]{1,60}:\s*/, "").trim().slice(0, 80) || key.slice(0, 80);
  return `${opsHref.tab("issues")}?${new URLSearchParams({ status: "all", lane: "all", q: message }).toString()}`;
}
