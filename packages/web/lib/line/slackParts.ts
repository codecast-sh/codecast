// Slack's own markup inside a finding's words (a quoted report, an escalation
// that pasted a Slack line): `<@U123>`, `<https://url|label>`, `<https://url>`,
// `<#C123|name>`. A reader sees a name and a link, never the markup. Pure.

export type SlackPart = string | { link: string; label: string } | { mention: string; name: string | null };

const TOKEN = /<(@[A-Z0-9]+(?:\|[^<>\n]*)?|#[A-Z0-9]+(?:\|[^<>\n]*)?|https?:\/\/[^<>\s|]+(?:\|[^<>\n]*)?|mailto:[^<>\s|]+(?:\|[^<>\n]*)?)>/g;

/** A text split at its Slack tokens. A mention carries the name Slack wrote beside it, if any; `channel` ones read as
 *  "#name". Text with no token comes back as one string. */
export function slackParts(text: string): SlackPart[] {
  const out: SlackPart[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    const [head, label] = m[1].split(/\|([^]*)/, 2) as [string, string | undefined];
    if (head.startsWith("@")) out.push({ mention: head.slice(1), name: label?.trim() || null });
    else if (head.startsWith("#")) out.push(`#${label?.trim() || head.slice(1)}`);
    else out.push({ link: head, label: label?.trim() || head.replace(/^mailto:/, "") });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  // Adjacent strings join, so a text with a lone `#channel` is still one string.
  return out.reduce<SlackPart[]>((acc, p) => (typeof p === "string" && typeof acc.at(-1) === "string" ? (acc[acc.length - 1] = (acc.at(-1) as string) + p, acc) : (acc.push(p), acc)), []);
}

/** Whether a text carries any Slack token worth splitting. */
export const hasSlackMarkup = (text: string): boolean => { TOKEN.lastIndex = 0; return TOKEN.test(text); };
