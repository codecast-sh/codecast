// What every inbox row reads about the people and roles around it, as the
// list's one subscription hands it down (components/SessionItem
// InboxRowEnvProvider). A context value change re-renders every mounted row,
// past their memo comparator, so each selector here keeps its value across a
// heartbeat: the roster as its identity fields (a teammate's presence beat
// hands the store a new roster array), the role rows as their face signature
// (a seat's session state rides the anchors they are built from). No React
// Native in here, so bun tests it directly.
import { rosterIdentity } from '@codecast/web/hooks/useTeamRoster';
import { teamMembersOf } from '@codecast/web/lib/activeTeam';
import { roleRowsSig } from '@codecast/web/lib/roleRows';

export const rowEnvMeId = (s: any): string | null => s.currentUser?._id?.toString?.() ?? null;
export const rowEnvRoster = (s: any) => rosterIdentity(teamMembersOf(s));
export const rowEnvRolesSig = (s: any): string => roleRowsSig(s as never);
