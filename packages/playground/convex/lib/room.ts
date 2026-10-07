// What a room message may hold: text a person typed and the element a
// point-and-talk message is about, both trimmed and capped.
import { ELEMENT_FIELD_MAX, MESSAGE_BODY_MAX } from "./limits";
import { oneLine } from "./text";

/** A message body: trimmed, capped; null when nothing is left. Inner newlines stay. */
export function cleanMessageBody(raw: string): string | null {
  const s = raw.replace(/\r\n?/g, "\n").trim().slice(0, MESSAGE_BODY_MAX).trim();
  return s.length ? s : null;
}

/** Free text as one line: whitespace collapsed, trimmed, capped; null when empty. */
export function cleanLine(raw: string, max: number): string | null {
  const s = oneLine(raw).slice(0, max).trim();
  return s.length ? s : null;
}

export type ElementFields = { selector: string; tag: string; text?: string; snippet?: string };

const clip = (s: string | undefined, max: number) => {
  const t = s?.trim().slice(0, max);
  return t ? t : undefined;
};

/** An element reference with every field capped; null when it names nothing. */
export function cleanElement(raw: ElementFields): ElementFields | null {
  const selector = clip(raw.selector, ELEMENT_FIELD_MAX.selector);
  const tag = clip(raw.tag, ELEMENT_FIELD_MAX.tag)?.toLowerCase();
  if (!selector || !tag) return null;
  const text = clip(raw.text && oneLine(raw.text), ELEMENT_FIELD_MAX.text);
  const snippet = clip(raw.snippet, ELEMENT_FIELD_MAX.snippet);
  return { selector, tag, ...(text ? { text } : {}), ...(snippet ? { snippet } : {}) };
}
