// What a connected app's history says about a person a question names (Union's `history.search` reader): the newest
// activities that name them, each as its time, where it happened and the words around the name. "Has Quinn left?" is
// answered by "Quinn was named Oct 12 in a contact's reply". Pure.

/** The reader that searches the app's history by keyword, and its arguments. */
export const HISTORY_SEARCH = { name: "history.search", query: "query", limit: "limit" } as const;

export type HistoryHit = { at: string; where: string | null; words: string };

/** The activity's machine head: its event kind and, for a relayed Slack post, the channel and poster
 *  ("slack_message_sent: #outreach | Aivery: "). */
const KIND = /^[a-z_]+:\s*(?:#[\w-]+\s*\|\s*[^:]{1,40}:\s*)?/;
const HIT = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s+(?:\[([^\]]+)\]\s+)?/;

/** Slack and Markdown markup as plain words: `<url|Name>` is Name, `*bold*` is bold, an id tail goes. */
const plain = (s: string) =>
  s.replace(/<[^|>]+\|([^>]+)>/g, "$1").replace(/<(https?:[^>]+)>/g, "$1").replace(/\*([^*\n]+)\*/g, "$1").replace(/\s*\(id: [0-9a-f-]+\)\s*$/i, "").replace(/\s+/g, " ").trim();

/** The words around the first mention of `name`, about `span` characters either side, cut at word ends. */
function around(text: string, name: string, span = 90): string {
  const i = text.search(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
  if (i < 0) return text.length > span * 2 ? `${text.slice(0, span * 2).replace(/\s+\S*$/, "")}…` : text;
  const from = Math.max(0, i - span);
  const to = Math.min(text.length, i + name.length + span);
  const head = from > 0 ? `…${text.slice(from, to).replace(/^\S*\s+/, "")}` : text.slice(0, to);
  return to < text.length ? `${head.replace(/\s+\S*$/, "")}…` : head;
}

/** A reader's answer as its words: JSON with them under `text`, or a plain answer that is its own words. */
export function appAnswerText(raw: string | null | undefined): string {
  const r = raw ?? "";
  if (!r.trimStart().startsWith("{")) return r;
  try {
    const j = JSON.parse(r) as { text?: unknown };
    return typeof j?.text === "string" ? j.text : r;
  } catch {
    return r;
  }
}

/** The reader's answer as hits, newest first as the app lists them. */
export function readHistoryHits(raw: string | null | undefined, name: string): HistoryHit[] {
  const t = appAnswerText(raw);
  const hits: Array<{ at: string; where: string | null; lines: string[] }> = [];
  for (const line of t.split("\n")) {
    const m = HIT.exec(line);
    if (m) hits.push({ at: m[1], where: m[2] ?? null, lines: [line.slice(m[0].length)] });
    else if (hits.length) hits[hits.length - 1].lines.push(line);
  }
  // An activity whose text the app cut before the name says nothing about them here: only hits that show it.
  const named = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return hits
    .map((h) => ({ at: h.at, where: h.where, text: plain(h.lines.join("\n")).replace(KIND, "") }))
    .filter((h) => named.test(h.text))
    .map((h) => ({ at: h.at, where: h.where, words: around(h.text, name) }));
}
