// The kill-a-role's-own-session question (components/org/SeatKillDialog.tsx):
// a kill gesture asks here, and the one dialog per window answers.
import { useInboxStore } from "../store/inboxStore";

let askedRoleId: string | null = null;
const listeners = new Set<() => void>();
const setAsked = (roleId: string | null) => { askedRoleId = roleId; listeners.forEach((fn) => fn()); };

export const seatKillAsk = {
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  get: () => askedRoleId,
};
export const closeSeatKillAsk = () => setAsked(null);

/** For a kill gesture: true when the session is a role's own and the retire
 *  question opened in its place, so the caller must not kill. */
export function askRetireInstead(sessionId: string): boolean {
  const s = useInboxStore.getState() as any;
  const live = s.resolveLiveSessionId?.(sessionId) ?? sessionId;
  const roleId = (s.sessions?.[live] ?? s.conversations?.[sessionId])?.standing_role_id;
  if (!roleId) return false;
  setAsked(String(roleId));
  return true;
}
