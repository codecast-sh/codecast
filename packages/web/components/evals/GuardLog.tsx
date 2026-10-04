// What the dry-run guard caught on an agent rep (calls.log): every cast
// command the agent typed and the guard's mark for it. LIVE is the one to
// read first: the agent saw the live workspace, so a replay will not see the
// same thing. REFUSED is an attempted write.

import { useState } from "react";
import { GUARD_STATUSES, type GuardCounts, type GuardEntry, type GuardStatus } from "@codecast/shared/contracts/evalsApi";
import { GUARD_WORDS, guardCounts } from "./runModel";

const countKey = (s: GuardStatus) => s.toLowerCase() as keyof GuardCounts;

export function GuardChip({ status }: { status: GuardStatus | null }) {
  return (
    <span className={`ev-gs ev-gs--${status ?? "none"}`} title={status ? GUARD_WORDS[status] : "Logged with no mark after it"} data-ev-guard-status={status ?? "none"}>
      {status ?? "no mark"}
    </span>
  );
}

export function GuardLog({ entries, counts }: { entries: readonly GuardEntry[]; counts?: GuardCounts }) {
  const [only, setOnly] = useState<GuardStatus | null>(null);
  const fromLog = guardCounts(entries);
  const shown = only ? entries.filter((e) => e.status === only) : entries;
  if (!entries.length) {
    return <div className="ev-card ev-empty-note">The guard logged nothing: this rep typed no cast commands.</div>;
  }
  return (
    <div className="flex flex-col gap-3" data-ev-guard>
      <div className="ev-guard-strip" role="group" aria-label="Filter by mark">
        {GUARD_STATUSES.map((s) => {
          const c = fromLog[s];
          const indexed = counts?.[countKey(s)];
          return (
            <button
              key={s}
              type="button"
              className={`ev-guard-count ev-gs--${s}`}
              style={{ background: "var(--sol-card)" }}
              aria-pressed={only === s}
              disabled={!c}
              title={`${GUARD_WORDS[s]}${indexed !== undefined && indexed !== c ? ` (the index counted ${indexed})` : ""}`}
              onClick={() => setOnly((o) => (o === s ? null : s))}
              data-ev-guard-count={s}
            >
              <span className="ev-num">{c}</span>
              <span>{s}</span>
            </button>
          );
        })}
      </div>
      <div className="ev-card overflow-hidden">
        <table className="ev-table">
          <thead>
            <tr>
              <th style={{ width: 44 }}>#</th>
              <th style={{ width: 96 }}>Mark</th>
              <th>Command</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e, i) => {
              const newTurn = i === 0 || shown[i - 1].turn !== e.turn;
              return [
                newTurn ? (
                  <tr key={`t${e.turn}-${e.seq}`} className="ev-guard-turn">
                    <td colSpan={3}>turn {e.turn}</td>
                  </tr>
                ) : null,
                <tr key={e.seq} data-ev-guard-row={e.status ?? "none"}>
                  <td className="ev-tabular ev-quiet">{e.seq}</td>
                  <td>
                    <GuardChip status={e.status} />
                  </td>
                  <td className="ev-mono break-all">{e.argv}</td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
