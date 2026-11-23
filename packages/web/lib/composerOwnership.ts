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
  useComposerOwnership.setState((s) => (s.sendAs[id]?.label === v?.label ? s : { sendAs: { ...s.sendAs, [id]: v } }));

/** Read at the send: the words go to the role's own session, not this one. */
export function composerTellsRole(conversationId: string): boolean {
  if (!useComposerOwnership.getState().tell[conversationId]) return false;
  const s = useInboxStore.getState() as any;
  const row = s.sessions?.[s.resolveLiveSessionId?.(conversationId) ?? conversationId] ?? s.conversations?.[conversationId];
  return !!row && !row.standing_role_id && roleDrives(row);
}

/** A role's name as the composer says it: "Growth lead" reads "Growth". */
export const roleShortName = (name: string) => name.replace(/\s+lead$/i, "") || name;
