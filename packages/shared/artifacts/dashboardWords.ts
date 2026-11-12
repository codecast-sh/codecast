// Words on a dashboard: live tokens ({b_key}, {b_key.delta}, {b_key.trend})
// inside prose, and the claims prose makes (typed numbers, directions stated
// in words) checked against the KPIs they name.
import type { KpiEval } from "./dashboardData";

// ── text with live numbers ──

/** What a {b_key}, {b_key.delta} or {b_key.trend} token reads as for an evaluated KPI. */
export function kpiPartText(ev: KpiEval, part: TokenPart): string {
  if (ev.state === "unbound") return part === "value" ? ev.display : "";
  if (ev.state !== "ok") return "…";
  if (part === "value") return ev.display;
  if (!ev.delta) return "";
  if (part === "delta") return ev.delta.display;
  if (part === "vs") return ev.delta.against;
  if (ev.delta.dir === "flat") return "flat";
  // From a tiny base, where the number came from says more than a percent.
  if (Math.abs(ev.delta.base) < 10) return `${ev.delta.dir} from ${ev.delta.base}`;
  return `${ev.delta.dir} ${ev.delta.display.replace(/^[+−±]/, "")}`;
}

/** A text block's pieces: literal text, and {b_key} / {b_key.delta} references to a KPI's live value. */
/** What a token reads: the value, its signed change, its direction ("up 12%"), or what it is compared with ("the prior 7 days"). */
export type TokenPart = "value" | "delta" | "trend" | "vs";
export type TextPart = { text: string } | { ref: string; part: TokenPart };

export function parseText(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = /\{(b_[A-Za-z0-9_]+)(?:\.(value|delta|trend|vs))?\}/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ ref: m[1], part: (m[2] as TokenPart) ?? "value" });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Numbers typed into the literal text rather than referenced: they trace to no source. */
export function typedNumbers(text: string): string[] {
  const literal = parseText(text)
    .map((p) => ("text" in p ? p.text : " "))
    .join("");
  const out: string[] = [];
  // A number in any form the tiles print or a person writes: 23, 4.5K, 1.2k, $600, 12%, 3x, 2.5 million, 9 PRs.
  for (const m of literal.matchAll(/(?<![\w.])[$+−-]?\d+(?:,\d{3})*(\.\d+)?(?:[%KMBkmb]|x)?(?![\w])(?:\s+(?:thousand|million|billion))?/g)) {
    const n = m[0];
    const plain = /^\d+$/.test(n);
    // A year, a window ("last 30 days"), a rank ("top 10") or a place in a list ("step 2") names what is measured, not a measurement.
    if (/^(19|20)\d\d$/.test(n)) continue;
    const before = literal.slice(0, m.index).match(/(\w+)\s*#?$/)?.[1]?.toLowerCase();
    const after = literal.slice(m.index! + n.length).match(/^\s*-?\s*(\w+)/)?.[1]?.toLowerCase();
    if (plain && ((before && /^(last|past|next|first|top|bottom|over|every|per|q[1-4]|step|part|phase|chapter|section|no|number|version|v|page|item)$/.test(before)) || (after && /^(days?|weeks?|months?|years?|hours?|minutes?|d|w|h|m|mins?|hrs?)$/.test(after)))) continue;
    // A lone digit counts only when it counts something ("9 PRs"); "1 of" a list or a digit ending a sentence is left alone.
    if (plain && n.length === 1 && (!after || /^(of|and|or|to)$/.test(after))) continue;
    out.push(n);
  }
  return out;
}

// ── directions stated in words ──

const UP_WORDS = /^(rose|rise[sn]?|rising|gr[eo]w[sn]?|growing|increas(e[sd]?|ing)|climb(s|ed|ing)?|jump(s|ed|ing)?|surg(e[sd]?|ing)|soar(s|ed|ing)?|gain(s|ed|ing)?|doubl(e[sd]?|ing)|tripl(e[sd]?|ing)|spik(e[sd]|ing)|accelerat(e[sd]?|ing))$/i;
const DOWN_WORDS = /^(f[ae]ll[sn]?|falling|fallen|drop(s|ped|ping)?|declin(e[sd]?|ing)|decreas(e[sd]?|ing)|shr[aiu]nk(s|ing)?|slip(s|ped|ping)?|slid(es|ing)?|plung(e[sd]?|ing)|plummet(s|ed|ing)?|dip(s|ped|ping)?|halv(e[sd]?|ing)|sank|sink(s|ing)?|slow(s|ed|ing)|cool(s|ed|ing))$/i;
// "up" and "down" claim a direction only next to a measurement: "spend is up 12%", "down from last week", "is up." Never "set up" or "follow up on".
const UP_DOWN_NEXT = /^(\u0000|[$+−-]?\d|from|on|vs|versus|over|since|than|compared|against|again|sharply|slightly|by|$)/i;

export type DirectionWord = { word: string; dir: "up" | "down" };

/** A clause: a sentence, or the side of a contrast ("but", "while"), with the live references it holds. */
type Clause = { words: string[]; refs: string[] };

function clauses(text: string): Clause[] {
  const parts = parseText(text);
  const refs: string[] = [];
  const flat = parts.map((p) => ("text" in p ? p.text : (refs.push(p.ref), ` \u0000${refs.length - 1}\u0000 `))).join("");
  return flat
    .split(/[.;!?\n]+|,?\s+\b(?:but|while|whereas|although|though|yet)\b/i)
    .map((c) => {
      const words = c.split(/[\s,:()"“”]+/).filter(Boolean);
      return { words, refs: [...c.matchAll(/\u0000(\d+)\u0000/g)].map((m) => refs[Number(m[1])]) };
    })
    .filter((c) => c.words.length);
}

/** The direction words in a clause, as claims. */
function clauseDirections(words: readonly string[]): DirectionWord[] {
  const out: DirectionWord[] = [];
  words.forEach((w, i) => {
    const word = w.replace(/[^A-Za-z]/g, "");
    if (!word) return;
    if (UP_WORDS.test(word)) out.push({ word, dir: "up" });
    else if (DOWN_WORDS.test(word)) out.push({ word, dir: "down" });
    // "up", "down", "higher", "lower" claim a direction only beside a measurement ("higher than", "up 12%"), never in "higher priority" or "lower bound".
    else if (/^(up|down|higher|lower)$/i.test(word) && UP_DOWN_NEXT.test(words[i + 1] ?? "")) out.push({ word, dir: /^(up|higher)$/i.test(word) ? "up" : "down" });
  });
  return out;
}

/** Every direction stated in words: what a live {b_key.trend} must carry instead, so the words can never contradict the data. */
export function directionWords(text: string): DirectionWord[] {
  return clauses(text).flatMap((c) => clauseDirections(c.words));
}

export type TextProblem = { kind: "contradicts" | "typed" | "unknown"; detail: string };

/**
 * Where words and data disagree. A clause that says "rose" about a KPI whose
 * change is down contradicts it; a direction or number with no live reference
 * to back it is typed. `kpi` evaluates a referenced KPI by key.
 */
export function textProblems(text: string, kpi: (key: string) => { title?: string; ev: KpiEval } | undefined): TextProblem[] {
  const out: TextProblem[] = [];
  // A token naming no KPI, or a part the page can't draw, prints raw to every reader.
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const ok = m[1].match(/^(b_[A-Za-z0-9_]+)(?:\.(value|delta|trend|vs))?$/);
    if (!ok) out.push({ kind: "unknown", detail: `{${m[1]}} is not a live value` });
    else if (!kpi(ok[1])) out.push({ kind: "unknown", detail: `{${m[1]}} names no KPI on this dashboard` });
  }
  const typed = typedNumbers(text);
  if (typed.length) out.push({ kind: "typed", detail: `${typed.join(", ")} ${typed.length === 1 ? "is" : "are"} typed, not read from a source` });
  for (const c of clauses(text)) {
    const dirs = clauseDirections(c.words);
    if (!dirs.length) continue;
    const moving = c.refs.map((k) => ({ k, t: kpi(k) })).filter((x) => x.t?.ev.state === "ok" && x.t.ev.delta);
    if (!moving.length) {
      out.push({ kind: "typed", detail: `"${dirs[0].word}" states a direction no live number backs` });
      continue;
    }
    for (const d of dirs) {
      // The clause's claim holds if any KPI it names moved that way.
      if (moving.some((m) => (m.t!.ev as Extract<KpiEval, { state: "ok" }>).delta!.dir === d.dir)) continue;
      const m = moving[0];
      const delta = (m.t!.ev as Extract<KpiEval, { state: "ok" }>).delta!;
      out.push({ kind: "contradicts", detail: `says "${d.word}" but ${m.t!.title || m.k} is ${delta.dir === "flat" ? "flat" : `${delta.dir} ${delta.display.replace(/^[+−±]/, "")}`}` });
    }
  }
  return out;
}

/**
 * The words a writer (an agent, the CLI) may store: no typed numbers and no
 * direction in words, since both go stale or wrong when the data turns. The
 * live tokens say them instead.
 */
export function writtenTextProblem(text: string): string | null {
  const typed = typedNumbers(text);
  if (typed.length) return `${typed.join(", ")} ${typed.length === 1 ? "is a typed number" : "are typed numbers"}: reference the KPI that holds it as {b_key}, or its change as {b_key.delta}`;
  const dirs = directionWords(text);
  if (dirs.length) return `"${dirs[0].word}" states a direction in words, which goes wrong when the data turns: write it as {b_key.trend} ("up 12%", "down 4%", "flat"), or show the signed change with {b_key.delta}`;
  return null;
}

