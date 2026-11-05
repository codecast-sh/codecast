// The health flag dots on an org card's top edge (OrgNodeCards).
import type { HealthFlag } from "./orgStaffingTypes";
import { SEVERITY_META } from "./orgMeta";
import { FLAG_LABEL } from "./staffingModel";

/** One dot per blocker or warning, worst first, the code and detail on hover.
 *  The severity is in the dot's shape (SEVERITY_META): a blocker is filled, a
 *  warning is a ring; an info flag draws nothing here (the pane lists it).
 *  Sits on the card's top right so it never competes with the name. */
export function FlagDots({ flags }: { flags?: HealthFlag[] }) {
  const rank = { blocker: 0, warn: 1, info: 2 } as const;
  const sorted = (flags ?? []).filter((f) => SEVERITY_META[f.severity].dot !== "none").sort((a, b) => rank[a.severity] - rank[b.severity]);
  if (sorted.length === 0) return null;
  return (
    <span className="absolute -top-[5px] right-2.5 flex items-center gap-[3px]" data-flags={sorted.map((f) => f.code).join(",")}>
      {sorted.map((f, i) => {
        const m = SEVERITY_META[f.severity];
        return (
          <span
            key={`${f.code}:${i}`}
            className="w-[10px] h-[10px] rounded-full box-border"
            style={m.dot === "filled"
              ? { background: m.color, boxShadow: "0 0 0 2px var(--sol-card)" }
              : { background: "var(--sol-card)", border: `2px solid ${m.color}`, boxShadow: "0 0 0 1.5px var(--sol-card)" }}
            title={`${m.word}: ${FLAG_LABEL[f.code]}. ${f.detail}`}
            aria-label={`${m.word}: ${FLAG_LABEL[f.code]}. ${f.detail}`}
            data-severity={f.severity}
          />
        );
      })}
    </span>
  );
}
