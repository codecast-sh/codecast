// A gate whose asking station posted its own decision (workflow `asker=`):
// that decision's options, in the order the session wrote them, matched onto
// the gate's edges, so an answer by option index routes the run. An option
// names its edge by label, or leads with it ("Revise: tighten the close
// note"), else by verdict; one that names no edge carries no key, and its
// label routes as text.
import { verdictOfOption } from "@codecast/shared/contracts/changeCard";

export type GateChoice = { key: string; label: string; description?: string; target: string };

const bare = (s: string) => s.replace(/^\s*\[?[A-Za-z0-9]{1,3}\]\s*/, "").trim().toLowerCase();

export function alignGateChoices(options: ReadonlyArray<{ label: string }>, choices: ReadonlyArray<GateChoice>): Array<GateChoice | null> {
  const taken = new Set<string>();
  const pick = (test: (c: GateChoice) => boolean) => {
    const c = choices.find((x) => !taken.has(x.key) && test(x));
    if (c) taken.add(c.key);
    return c ?? null;
  };
  return options.map((o) => {
    const label = bare(o.label);
    const verdict = verdictOfOption(o.label);
    const leads = (c: GateChoice) => { const g = bare(c.label); return label === g || label.startsWith(`${g} `) || label.startsWith(`${g}:`); };
    return pick((c) => bare(c.label) === label) ?? pick(leads) ?? (verdict ? pick((c) => verdictOfOption(c.label) === verdict) : null);
  });
}
