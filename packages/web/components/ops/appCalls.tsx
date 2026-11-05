// The Apps tab's call log pieces: a failing call group's detail, the outcome
// and caller filters over the log, and the switch that hands a failing group
// to an agent.
import { useMemo } from "react";
import { Wand2 } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { EntityIdPill } from "../EntityIdPill";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { callFixFacts, type CallFilter, type CallGroup } from "./appsModel";
import type { OpsSource } from "./opsTypes";
import { fixLedger } from "./opsHomeModel";
import { fixSessionPath, startOpsFixSession } from "./startFix";

/** Occurrences a call group lists before it counts the rest. */
const OCCURRENCES = 8;

export const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export const moment = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A reader or action that keeps failing, handed to an agent: one session starts, seeded with the failures, in the app's project. */
export function CallFix({ source, group }: { source: Pick<OpsSource, "_id" | "name"> & { short_id?: string }; group: CallGroup }) {
  const facts = callFixFacts({ name: source.name, short_id: source.short_id ?? "" }, group);
  const folder = useMemo(() => fixSessionPath(useInboxStore.getState() as any, source._id), [source._id]);
  return (
    <ConsequentialSwitch
      on={false}
      ledger={fixLedger(facts.ref, facts.title, folder)}
      onTurnOn={() => startOpsFixSession({ groupRefs: [], title: facts.title, failure: facts.failure }, source._id)}
      onTurnOff={() => {}}
      trigger={({ press }) => (
        <button type="button" className="ops-btn ops-call-fix" data-size="sm" data-tone="primary" onClick={press} title="Start a session seeded with these failures" data-ops-call-fix={group.name}>
          <Wand2 className="w-3.5 h-3.5" /> Start fix
        </button>
      )}
    />
  );
}

export function CallGroupDetail({ group }: { group: CallGroup }) {
  const more = group.count - OCCURRENCES;
  return (
    <>
      {group.reasons.filter((r) => r.error).map((r) => (
        <div key={r.reason} className="ops-reason">
          <div className="ops-reason-head"><span>{r.reason}</span><span className="ops-dim ops-num">{r.count}</span></div>
          <pre className="ops-fulltext">{r.error}</pre>
        </div>
      ))}
      <table className="ops-occ">
        <thead>
          <tr><th>{group.kind} <span className="ops-mono">{group.name}</span></th><th>ms</th><th>bytes</th><th>Session</th></tr>
        </thead>
        <tbody>
          {group.calls.slice(0, OCCURRENCES).map((c) => (
            <tr key={c._id}>
              <td>{moment(c.created_at)}{c.http_status ? <span className="ops-dim"> · {c.http_status}</span> : null}</td>
              {/* A call refused or failed before it reached the app has no time or size to show. */}
              <td className="ops-num">{c.ms || c.bytes ? c.ms.toLocaleString() : ""}</td>
              <td className="ops-num">{c.ms || c.bytes ? c.bytes.toLocaleString() : ""}</td>
              <td className="ops-ref-fit">{c.conversation_id ? <EntityIdPill type="session" id={c.conversation_id} compact /> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {more > 0 && <div className="ops-dim text-[11px] ops-num">+{more} earlier, back to {day(group.oldest)}</div>}
    </>
  );
}

const STATUS_PICKS: { key: CallFilter["status"]; label: string }[] = [{ key: null, label: "All" }, { key: "error", label: "Failed" }, { key: "denied", label: "Refused" }, { key: "ok", label: "OK" }];
const ACTOR_PICKS: { key: CallFilter["actor"]; label: string }[] = [{ key: null, label: "Anyone" }, { key: "session", label: "Agent" }, { key: "watch", label: "Watch" }, { key: "cli", label: "CLI" }];

export function CallFilters({ value, actors, onChange }: { value: CallFilter; actors: ReadonlySet<string>; onChange: (f: CallFilter) => void }) {
  return (
    <span className="ops-call-filters">
      <span className="ops-seg" role="group" aria-label="Outcome">
        {STATUS_PICKS.map((p) => <button key={p.label} type="button" data-on={value.status === p.key ? "true" : undefined} aria-pressed={value.status === p.key} onClick={() => onChange({ ...value, status: p.key })}>{p.label}</button>)}
      </span>
      <span className="ops-seg" role="group" aria-label="Who called">
        {ACTOR_PICKS.filter((p) => !p.key || actors.has(p.key) || value.actor === p.key).map((p) => <button key={p.label} type="button" data-on={value.actor === p.key ? "true" : undefined} aria-pressed={value.actor === p.key} onClick={() => onChange({ ...value, actor: p.key })}>{p.label}</button>)}
      </span>
    </span>
  );
}
