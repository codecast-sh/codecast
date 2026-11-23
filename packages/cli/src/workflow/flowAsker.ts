// What a flow station reads to learn who asked for a change (`cast flow
// asker`): the chain from the change's session up to the one that started
// the work, its originator, who started the run (`--run`, read from the run
// on the server), every line a person typed along it with its provenance,
// and the answers people gave to the decision cards those sessions (and,
// with `--task`, the task) asked (/cli/sessions/originator). Text a program put into a session never
// appears as typed.
//
// The answer prints as one JSON object a station records whole (commandStation
// NODE_JSON_CAP), so it is fitted under that cap. The words are in `text`, one
// chronological list rendered for a model, a typed line as
// `[<short_id>:<line>] <time> <name> (<provenance>): <words>` and a card answer
// as `[card <sd-N> in <short_id>, <time>] <name> answered "<option>" to
// "<question>": <note>` (`on this task` for the task's own cards), so a later
// "don't ship yet" or Revise reads after the "ship it" it takes back. The coordinates live in each line's prefix, so the per-line records are
// left out (the server re-reads any line a clear cites). When the list does not
// fit, the newest lines stay whole, since the newest word decides, and the
// oldest are left out, with a first line saying how many.

/** The JSON size a station records (commandStation NODE_JSON_CAP is 64,000), with room to spare. */
const RECORD_CAP = 63_000;
/** The most of one line's words the list carries, both ends kept. */
const LINE_CAP = 8_000;

type Typed = { short_id: string; line: number; user_name: string | null; provenance: string; text: string; created_at: string };
type Card = { card: string; session_short_id?: string; on_task?: boolean; question: string; user_name: string | null; answer: string; note?: string; created_at: string };
export type AskerRead = { typed: Typed[]; cards?: Card[] } & Record<string, unknown>;

/** The most of a card's question the list carries, both ends kept. */
const QUESTION_CAP = 500;

function keepEnds(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = Math.ceil(cap / 2);
  const tail = cap - head;
  return `${text.slice(0, head)}[... ${text.length - cap} characters left out here ...]${tail > 0 ? text.slice(-tail) : ""}`;
}

/** A moment to the minute, in UTC: 2026-11-22 10:04Z. */
const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;

/** Every typed line and card answer as the model reads it, oldest first. */
function rendered(read: AskerRead): string[] {
  return [
    ...read.typed.map((t) => ({ at: t.created_at, line: t.line, words: `[${t.short_id}:${t.line}] ${minute(t.created_at)} ${t.user_name ?? "someone"} (${t.provenance}): ${keepEnds(t.text, LINE_CAP)}` })),
    ...(read.cards ?? []).map((v) => {
      const where = [v.session_short_id ? `in ${v.session_short_id}` : "", v.on_task ? "on this task" : ""].filter(Boolean).join(", ");
      return {
        at: v.created_at,
        line: 0,
        words: `[card ${v.card}${where ? ` ${where}` : ""}, ${minute(v.created_at)}] ${v.user_name ?? "someone"} answered "${v.answer}" to "${keepEnds(v.question, QUESTION_CAP)}"${v.note ? `: ${keepEnds(v.note, LINE_CAP)}` : ""}`,
      };
    }),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.line - b.line).map((e) => e.words);
}

/** The record, its JSON within `record`: the newest lines whole, the oldest left out first. */
export function fitAskerRecord(read: AskerRead, record = RECORD_CAP): Record<string, unknown> {
  const { typed: _typed, cards: _cards, ...base } = read;
  const lines = rendered(read);
  // A line's escaped length, and the newline before it ("\n" in JSON).
  const cost = (s: string) => JSON.stringify(s).length - 2 + 2;
  // Room for `text` once everything else is in, and for the line that says how many were left out.
  let room = record - JSON.stringify({ ...base, text: "" }).length - 80;
  let kept = 0;
  for (let i = lines.length - 1; i >= 0 && cost(lines[i]) <= room; i--, kept++) room -= cost(lines[i]);
  const shown = lines.slice(lines.length - kept);
  const left = lines.length - kept;
  return { ...base, text: [...(left ? [`[... ${left} earlier ${left === 1 ? "line" : "lines"} left out ...]`] : []), ...shown].join("\n") };
}
