// The session composer's owner choices (components/conversation/ComposerOwnerStrip):
// whether a send tells the role instead of taking the wheel, and what Send
// does now. Ephemeral and per tab: nothing here reaches the server.
import { create } from "zustand";
import { roleDrives } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import type { OwnerRole, OwnersApi } from "../hooks/useOwners";

/** What Send does while the line shows: its words, and the role it tells. */
export type ComposerSendAs = { label: string; tellRole: string | null };

/** Per-session composer choices: Tell (a person's pick, kept for the tab's
 *  life) and what Send does now (the line's own reading, for the button). */
export const useComposerOwnership = create<{ tell: Record<string, boolean>; sendAs: Record<string, ComposerSendAs | null> }>(() => ({ tell: {}, sendAs: {} }));

export const setComposerTell = (id: string, on: boolean) => useComposerOwnership.setState((s) => ({ tell: { ...s.tell, [id]: on } }));
export const setComposerSendAs = (id: string, v: ComposerSendAs | null) =>
  useComposerOwnership.setState((s) => (s.sendAs[id]?.label === v?.label && s.sendAs[id]?.tellRole === v?.tellRole ? s : { sendAs: { ...s.sendAs, [id]: v } }));

/**
 * Where the session composer's send goes, read at the send:
 *   tell-role  Tell chosen while the role drives: to the role's own session
 *   plain      Tell chosen while a person drives: into the session, the
 *              driver unchanged
 *   take-over  into the session, taking the wheel (a no-op for its driver)
 */
export type ComposerSendRoute = "tell-role" | "plain" | "take-over";

export function composerSendRoute(conversationId: string): ComposerSendRoute {
  if (!useComposerOwnership.getState().tell[conversationId]) return "take-over";
  const s = useInboxStore.getState() as any;
  const row = s.sessions?.[s.resolveLiveSessionId?.(conversationId) ?? conversationId] ?? s.conversations?.[conversationId];
  return row && !row.standing_role_id && roleDrives(row) ? "tell-role" : "plain";
}

/** The send's flag for the server and the store: only a take-over route asks. */
export const takeOverFor = (route: ComposerSendRoute | null) => (route === "take-over" ? { take_over: true } : undefined);

/** A role's name as the composer says it: "Growth lead" reads "Growth". */
export const roleShortName = (name: string) => name.replace(/\s+lead$/i, "") || name;

/** A person's name as the composer says it: their first name. */
export const personShortName = (name: string) => name.split(/\s+/)[0] || name;

/**
 * What the line above a session's composer says (web ComposerOwnerStrip, the
 * phone's composer strip), read off the owners: only for an owner or the
 * runner, never in a role's own session.
 *   role     a role drives: sending takes over from it, or Tell it
 *   person   another person drives: sending takes over, or Tell keeps them
 *   paused   you drive and the filed role waits
 * `label` is what Send does while the line shows; `tellRole` the role a Tell
 * goes to (a person is told in this session).
 */
export type ComposerOwnerLine =
  | { kind: "paused"; role: OwnerRole; label: null; tellRole: null }
  | { kind: "role"; role: OwnerRole; driverName: string; telling: boolean; label: string; tellRole: string | null }
  | { kind: "person"; person: { _id: string; name: string; image?: string }; driverName: string; telling: boolean; label: string; tellRole: null };

export function composerOwnerLine(
  owners: Pick<OwnersApi, "driver" | "role" | "ownerList" | "displayFor" | "session" | "currentUser">,
  standing: boolean,
  tell: boolean,
): ComposerOwnerLine | null {
  const { driver, role, ownerList, displayFor, session } = owners;
  const me: string | undefined = owners.currentUser?._id?.toString?.();
  if (!me || standing || !(ownerList.includes(me) || session.runner_id === me) || !driver) return null;
  if (driver.kind === "user" && driver.user_id === me) return role ? { kind: "paused", role, label: null, tellRole: null } : null;
  if (driver.kind === "role") {
    if (!role) return null;
    const driverName = roleShortName(role.name);
    return { kind: "role", role, driverName, telling: tell, label: tell ? `Tell ${driverName}` : "Take over", tellRole: tell ? role.name : null };
  }
  const p = displayFor(driver.user_id);
  const driverName = personShortName(p.name);
  return { kind: "person", person: { _id: driver.user_id, ...p }, driverName, telling: tell, label: tell ? `Tell ${driverName}` : "Take over", tellRole: null };
}
