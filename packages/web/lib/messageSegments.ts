// A typed message as a list row draws it: the typed text, with each pasted
// block and each attached image folded into one chip. Works on a clipped
// snippet too (a paste whose closing tag was cut runs to the end).
export type Seg = { kind: "text"; text: string } | { kind: "paste"; lines: number } | { kind: "image"; label: string };

const PASTE_RE = /<pasted_content(?=[\s>])[^>]*>\r?\n?([\s\S]*?)(?:\r?\n?<\/pasted_content[^>]*>|$)/g;
const IMAGE_RE = /\[Image(?:[:\s#]*(\d+))?[^\]]*\]/g;

/** A message as the list draws it: what was typed, with a pasted block and an
 *  attached image each folded into one chip. */
export function segmentsOf(text: string): Seg[] {
  const out: Seg[] = [];
  const pushText = (t: string) => {
    let last = 0;
    for (const m of t.matchAll(IMAGE_RE)) {
      if (m.index! > last) out.push({ kind: "text", text: t.slice(last, m.index) });
      out.push({ kind: "image", label: m[1] ? `image ${m[1]}` : "image" });
      last = m.index! + m[0].length;
    }
    if (last < t.length) out.push({ kind: "text", text: t.slice(last) });
  };
  let last = 0;
  for (const m of text.matchAll(PASTE_RE)) {
    if (m.index! > last) pushText(text.slice(last, m.index));
    out.push({ kind: "paste", lines: (m[1] ?? "").split("\n").filter((l) => l.trim()).length });
    last = m.index! + m[0].length;
  }
  if (last < text.length) pushText(text.slice(last));
  // Trim the outer whitespace the folds leave behind.
  const first = out[0];
  if (first?.kind === "text") first.text = first.text.replace(/^\s+/, "");
  const end = out[out.length - 1];
  if (end?.kind === "text") end.text = end.text.replace(/\s+$/, "");
  return out.filter((s) => s.kind !== "text" || s.text);
}

