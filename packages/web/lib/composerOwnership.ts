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
 *   tell-role  Tell chosen while the role is Active: to the role's own session
 *   take-over  Pause and send while the role is Active: into the session,
 *              pausing the role (the server's take-over)
 *   plain      every other send: into the session, nothing paused. Between
 *              people a send never takes anything over.
 */
export type ComposerSendRoute = "tell-role" | "plain" | "take-over";

export function composerSendRoute(conversationId: string): ComposerSendRoute {
  const s = useInboxStore.getState() as any;
  const row = s.sessions?.[s.resolveLiveSessionId?.(conversationId) ?? conversationId] ?? s.conversations?.[conversationId];
  if (!row || row.standing_role_id || !roleDrives(row)) return "plain";
  return useComposerOwnership.getState().tell[conversationId] ? "tell-role" : "take-over";
}

/** The send's flag for the server and the store: only a send that pauses an
 *  Active role asks. */
export const takeOverFor = (route: ComposerSendRoute | null) => (route === "take-over" ? { take_over: true } : undefined);

/** A role as the owners UI names it in a line or a chip: "@growth" (its
 *  name while its handle has not loaded). */
export const roleTag = (role: Pick<OwnerRole, "handle" | "name">) => (role.handle ? `@${role.handle}` : role.name || "the role");

/**
 * What the line above a session's composer says (web ComposerOwnerStrip, the
 * phone's composer strip), read off the owners: only for an owner or the
 * runner, never in a role's own session, and only about the role:
 *   active  the role is Active: sending pauses it ("Pause and send"), or
 *           Tell sends to the role's own session and leaves it Active
 *   paused  you paused the role (your send did): Resume puts it back
 * `label` is what Send does while the line shows; `tellRole` the role a Tell
 * goes to. People never appear: a send between them changes nothing.
 */
export type ComposerOwnerLine =
  | { kind: "paused"; role: OwnerRole; tag: string; label: null; tellRole: null }
  | { kind: "active"; role: OwnerRole; tag: string; telling: boolean; label: string; tellRole: string | null };

export function composerOwnerLine(
  owners: Pick<OwnersApi, "driver" | "role" | "ownerList" | "session" | "currentUser">,
  standing: boolean,
  tell: boolean,
): ComposerOwnerLine | null {
  const { driver, role, ownerList, session } = owners;
  const me: string | undefined = owners.currentUser?._id?.toString?.();
  if (!me || standing || !role || !(ownerList.includes(me) || session.runner_id === me) || !driver) return null;
  const tag = roleTag(role);
  if (driver.kind === "role") return { kind: "active", role, tag, telling: tell, label: tell ? `Tell ${tag}` : "Pause and send", tellRole: tell ? role.name : null };
  return driver.user_id === me ? { kind: "paused", role, tag, label: null, tellRole: null } : null;
}
