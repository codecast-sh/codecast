// What a selection across chat rows becomes on the clipboard: one header per
// run of lines from the same person ("Ashot Petrosian · 5:00 PM"), then their
// lines, with none of the row chrome (reactions, toolbars, hover clocks,
// thread links) the browser would otherwise copy along.

export type ChatCopyPart = { author: string; createdAt: number; text: string };

// A new header when the speaker changes, or the same speaker comes back
// after a pause long enough that the earlier time would mislead.
const REGROUP_MS = 10 * 60_000;

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

// Mentions and entity links are markdown with app routes behind them; on the
// clipboard they read as their labels, the way they read on screen.
const MD_LINK = /\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))+\)/g;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** A message's source as someone reading it would copy it. */
export function chatPlainText(markdown: string): string {
  return markdown.replace(MD_LINK, "$1").replace(INVISIBLE, "");
}

type Group ={ author: string; createdAt: number; lines: string[] };

function groupParts(parts: ChatCopyPart[]): Group[] {
  const groups: Group[] = [];
  let lastAt = 0;
  for (const p of parts) {
    const text = p.text.replace(INVISIBLE, "").trim();
    if (!text) continue;
    const prev = groups[groups.length - 1];
    if (prev && prev.author === p.author && p.createdAt - lastAt < REGROUP_MS) prev.lines.push(text);
    else groups.push({ author: p.author, createdAt: p.createdAt, lines: [text] });
    lastAt = p.createdAt;
  }
  return groups;
}

/** Headers carry the date unless every line is from today. */
function stamper(groups: Group[], now: number) {
  const today = new Date(now).toDateString();
  const allToday = groups.every((g) => new Date(g.createdAt).toDateString() === today);
  return (ts: number) => (allToday ? TIME.format(ts) : `${DATE.format(ts)}, ${TIME.format(ts)}`);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function formatChatCopy(parts: ChatCopyPart[], now = Date.now()): { text: string; html: string } | null {
  const groups = groupParts(parts);
  if (groups.length === 0) return null;
  const stamp = stamper(groups, now);
  const text = groups.map((g) => `${g.author} · ${stamp(g.createdAt)}\n${g.lines.join("\n")}`).join("\n\n");
  const html = groups
    .map(
      (g) =>
        `<p><strong>${escapeHtml(g.author)}</strong> · ${escapeHtml(stamp(g.createdAt))}</p>` +
        g.lines.map((l) => `<p>${escapeHtml(l).replace(/\n/g, "<br>")}</p>`).join(""),
    )
    .join("");
  return { text, html };
}
