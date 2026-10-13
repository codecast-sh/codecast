// The "not a book" rule as a check (AGENTS.md UI conventions): every word a
// review shows fits a glance. A figure's label and a row's key are a few
// words; a row's value is a short phrase with no sentence in it.
import assert from "node:assert/strict";
import type { SwitchLedger } from "../ConsequentialSwitch";

const words = (s: string) => s.trim().split(/\s+/).filter((w) => w !== "·").length;
// A second clause after a stop, or a long run of words ending in one: an abbreviation ("est.") or "$?" is not a sentence.
const isSentence = (s: string) => /[.!?;]\s+\S/.test(s) || (words(s) > 3 && /[.!?]$/.test(s));

export function assertGlance(l: SwitchLedger) {
  const check = (where: string, s: string, max: number) => {
    assert.ok(words(s) <= max, `${l.name} ${where} "${s}" is ${words(s)} words, more than ${max}`);
    assert.ok(!isSentence(s), `${l.name} ${where} "${s}" reads as a sentence`);
  };
  check("name", l.name, 5);
  check("confirm", l.confirm, 5);
  if (l.alert) check("alert", l.alert, 5);
  if (l.stop) check("stop", l.stop, 6);
  for (const f of l.figures) { check("figure value", f.value, 2); check("figure label", f.label, 4); }
  for (const r of l.rows) { check("row key", r.k, 2); check("row value", r.v, 6); }
  for (const x of [...(l.hands?.its ?? []), ...(l.hands?.yours ?? [])]) check("hand", x, 4);
}
