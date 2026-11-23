// The session composer's owner choices (components/conversation/ComposerOwnerStrip):
// whether a send tells the role instead of taking the wheel, and what Send
// does now. Ephemeral and per tab: nothing here reaches the server.
import { create } from "zustand";
import { roleDrives } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";

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
