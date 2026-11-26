// Who a decision names (its owner, who answered it), as `user:<id>` and
// `role:<id>` keys read against the workspace's roster and org roles: a name
// and a face for each. The Decisions list labels owners with it and the
// answered feed labels answerers, so both name a party the same way.
import { useCallback, useMemo, type ReactNode } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useTeamRosterIdentity } from "./useTeamRoster";
import { useRolesAndPeopleOptions, type AssigneeOption } from "./useRolesAndPeopleOptions";

export type DecisionPartyLabel = { label: string; face: ReactNode };

export function useDecisionParties(): {
  me: string | null;
  people: AssigneeOption[];
  roles: AssigneeOption[];
  parties: Map<string, DecisionPartyLabel>;
  partyOf: (key: string) => DecisionPartyLabel | null;
} {
  const me = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const roster = useTeamRosterIdentity();
  const { people, roles } = useRolesAndPeopleOptions(roster);
  const parties = useMemo(() => {
    const m = new Map<string, DecisionPartyLabel>();
    for (const p of people) m.set(`user:${p.key}`, { label: p.key === me ? `${p.label} (you)` : p.label, face: p.face });
    for (const r of roles) m.set(`role:${r.key}`, { label: r.label, face: r.face });
    return m;
  }, [people, roles, me]);
  const partyOf = useCallback((key: string) => parties.get(key) ?? null, [parties]);
  return { me, people, roles, parties, partyOf };
}
