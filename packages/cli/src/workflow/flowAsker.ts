// What a flow station reads to learn who asked for a change (`cast flow
// asker`): the chain from the change's session up to the one that started
// the work, its originator, and every line a person typed along it, each
// with its provenance (/cli/sessions/originator). Text a program put into a
// session never appears as typed.
//
// The answer prints as one JSON object a station records whole (commandStation
// NODE_JSON_CAP), so it is fitted under that cap: every typed line keeps its
// session, line and message, and the longest texts lose their middles first.

/** The JSON size a station records (commandStation NODE_JSON_CAP is 64,000), with room to spare. */
const RECORD_CAP = 63_000;

type Typed = { text: string } & Record<string, unknown>;
export type AskerRead = { typed: Typed[] } & Record<string, unknown>;

function keepEnds(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = Math.ceil(cap / 2);
  const tail = cap - head;
  return `${text.slice(0, head)}[... ${text.length - cap} characters left out here ...]${tail > 0 ? text.slice(-tail) : ""}`;
}

/** The read with each typed text cut to at most `cap` characters. */
function capTexts(read: AskerRead, cap: number): AskerRead {
  return { ...read, typed: read.typed.map((t) => ({ ...t, text: keepEnds(t.text, cap) })) };
}

/** The read whose JSON fits `record`: the largest per-text cap that fits, so short lines stay whole. */
export function fitAskerRecord(read: AskerRead, record = RECORD_CAP): AskerRead {
  if (JSON.stringify(read).length <= record) return read;
  let lo = 0;
  let hi = Math.max(0, ...read.typed.map((t) => t.text.length));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(capTexts(read, mid)).length <= record) lo = mid;
    else hi = mid - 1;
  }
  return capTexts(read, lo);
}
