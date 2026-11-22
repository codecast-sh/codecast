// What a flow station reads to learn who asked for a change (`cast flow
// asker`): the chain from the change's session up to the one that started
// the work, its originator, who started the run (`--run`, read from the run
// on the server), every line a person typed along it with its provenance,
// and (`--task`) the answers people gave on the task's Ship cards
// (/cli/sessions/originator). Text a program put into a session never
// appears as typed.
//
// The answer prints as one JSON object a station records whole (commandStation
// NODE_JSON_CAP), so it is fitted under that cap. The words are in `text`, one
// chronological list rendered for a model, a typed line as
// `[<short_id>:<line>] <time> <name> (<provenance>): <words>` and a card answer
// as `[<card>] <time> <name> answered <option> on this task's Ship card: <note>`,
// so a later "don't ship yet" or Revise reads after the "ship it" it takes
// back. `typed` keeps each line's coordinates without its words. When it does
// not fit, the longest texts lose their middles first.

/** The JSON size a station records (commandStation NODE_JSON_CAP is 64,000), with room to spare. */
const RECORD_CAP = 63_000;

type Typed = { short_id: string; line: number; user_name: string | null; provenance: string; text: string; created_at: string } & Record<string, unknown>;
type Verdict = { card: string; user_name: string | null; answer: string; note?: string; created_at: string };
export type AskerRead = { typed: Typed[]; task?: { verdicts?: Verdict[] } & Record<string, unknown> } & Record<string, unknown>;

function keepEnds(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = Math.ceil(cap / 2);
  const tail = cap - head;
  return `${text.slice(0, head)}[... ${text.length - cap} characters left out here ...]${tail > 0 ? text.slice(-tail) : ""}`;
}

/** A moment to the minute, in UTC: 2026-11-22 10:04Z. */
const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;

/** The record with each text cut to at most `cap` characters. */
function render(read: AskerRead, cap: number): Record<string, unknown> {
  const typed = [...read.typed].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.line - b.line);
  const entries = [
    ...typed.map((t) => ({ at: t.created_at, words: `[${t.short_id}:${t.line}] ${minute(t.created_at)} ${t.user_name ?? "someone"} (${t.provenance}): ${keepEnds(t.text, cap)}` })),
    ...(read.task?.verdicts ?? []).map((v) => ({
      at: v.created_at,
      words: `[${v.card}] ${minute(v.created_at)} ${v.user_name ?? "someone"} answered ${v.answer} on this task's Ship card${v.note ? `: ${keepEnds(v.note, cap)}` : ""}`,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return { ...read, typed: typed.map(({ text: _words, ...coordinates }) => coordinates), text: entries.map((e) => e.words).join("\n") };
}

/** The record whose JSON fits `record`: the largest per-text cap that fits, so short lines stay whole. */
export function fitAskerRecord(read: AskerRead, record = RECORD_CAP): Record<string, unknown> {
  const whole = Math.max(0, ...read.typed.map((t) => t.text.length), ...(read.task?.verdicts ?? []).map((v) => v.note?.length ?? 0));
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
