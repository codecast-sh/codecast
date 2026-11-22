// What a flow station reads to learn who asked for a change (`cast flow
// asker`): the chain from the change's session up to the one that started
// the work, its originator, who started the run (`--run`, read from the run
// on the server), and every line a person typed along it, each with its
// provenance (/cli/sessions/originator). Text a program put into a session
// never appears as typed.
//
// The answer prints as one JSON object a station records whole (commandStation
// NODE_JSON_CAP), so it is fitted under that cap. The typed lines' words are
// in `text`, rendered for a model one per line as
// `[<short_id>:<line>] <name> (<provenance>): <words>`, oldest session first;
// `typed` keeps each line's coordinates without its words. When it does not
// fit, the longest texts lose their middles first.

/** The JSON size a station records (commandStation NODE_JSON_CAP is 64,000), with room to spare. */
const RECORD_CAP = 63_000;

type Typed = { short_id: string; line: number; user_name: string | null; provenance: string; text: string; created_at: string } & Record<string, unknown>;
export type AskerRead = { typed: Typed[] } & Record<string, unknown>;

function keepEnds(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = Math.ceil(cap / 2);
  const tail = cap - head;
  return `${text.slice(0, head)}[... ${text.length - cap} characters left out here ...]${tail > 0 ? text.slice(-tail) : ""}`;
}

/** The typed lines grouped by session, sessions in the order their first line was typed, lines in order within each. */
function oldestSessionFirst(typed: Typed[]): Typed[] {
  const first = new Map<string, string>();
  for (const t of typed) if (!first.has(t.short_id) || t.created_at < first.get(t.short_id)!) first.set(t.short_id, t.created_at);
  return [...typed].sort((a, b) => first.get(a.short_id)!.localeCompare(first.get(b.short_id)!) || a.short_id.localeCompare(b.short_id) || a.line - b.line);
}

/** The record with each typed text cut to at most `cap` characters. */
function render(read: AskerRead, cap: number): Record<string, unknown> {
  const typed = oldestSessionFirst(read.typed);
  const text = typed
    .map((t) => `[${t.short_id}:${t.line}] ${t.user_name ?? "someone"} (${t.provenance}): ${keepEnds(t.text, cap)}`)
    .join("\n");
  return { ...read, typed: typed.map(({ text: _words, ...coordinates }) => coordinates), text };
}

/** The record whose JSON fits `record`: the largest per-text cap that fits, so short lines stay whole. */
export function fitAskerRecord(read: AskerRead, record = RECORD_CAP): Record<string, unknown> {
  const whole = Math.max(0, ...read.typed.map((t) => t.text.length));
  if (JSON.stringify(render(read, whole)).length <= record) return render(read, whole);
  let lo = 0;
  let hi = whole;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (JSON.stringify(render(read, mid)).length <= record) lo = mid;
    else hi = mid - 1;
  }
  return render(read, lo);
}
