"use client";

/**
 * The OWNERS axis of a session — the SET of teammates whose inboxes it appears
 * in and who receive its notifications. This is the platform-free core shared
 * by the web AssignmentBadge and the mobile AssignmentChip: it owns the live
 * listOwners query (owner set only — the picker roster is a separate
 * listOwnerCandidates subscription, mounted only while the menu is open) and
 * the optimistic in-flight overrides, and exposes toggle / clearAll / display
 * helpers.
 *
 * MOBILE-SAFE by construction: this file is bundled into the Expo app, so no
 * DOM, no sonner, no window/document (see shared-code Hermes traps). The
 * environment injects what differs per platform: the team roster + current
 * user (web reads the inbox store; mobile queries convex per screen) and a
 * notify callback (web: sonner toast; mobile: the session screen's toast).
 */

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { isConvexId } from "../lib/entityLinks";
import { useWatchEffect } from "./useWatchEffect";
import { useQueryNoThrow } from "./useQueryNoThrow";

type OwnerInfo = {
  user_id: string;
  name: string | null;
  email: string | null;
  // Assignment provenance off the session_owners row (see sessionOwnership).
  added_by?: string;
  added_by_name?: string | null;
  added_at?: number;
  note?: string | null;
  seen_at?: number | null;
};

export type OwnersEnv = {
  // Warm-paint fallback roster only: the picker overlays the SESSION team's
  // members via listOwnerCandidates (subscribed only while the menu is open).
  teamMembers: any[] | undefined;
  currentUser: any;
  notify?: (msg: string, kind: "success" | "error") => void;
};

/**
 * Whether the live listOwners subscription should run. Skipped while the row
 * is an optimistic stub (client UUID, no server row yet) — the query resolves
 * null for a ref the server doesn't know — and whenever there is no current
 * user: every feature this hook powers is per-user, and a guest on a share
 * link has nothing to assign. The server also returns null without auth
 * rather than throwing, so a stale cookie cannot unmount the view.
 */
export function shouldQueryOwners(conversationId: string, currentUser: unknown): boolean {
  return Boolean(conversationId && isConvexId(conversationId) && currentUser);
}

/**
 * The roster the picker offers. The server's list wins — listOwnerCandidates
 * returns the SESSION team's members, the only people the owner mutations
 * accept. The injected roster (the viewer's active team) is a warm-paint
 * fallback for while that query loads.
 */
export function pickRoster(
  serverMembers: any[] | undefined,
  injected: any[] | undefined,
): any[] {
  return serverMembers ?? injected ?? [];
}

/**
 * Session-team roster for the assignment picker. Skip while the menu is
 * closed: this is the collect that timed listOwners out when it ran for
 * every open conversation.
 */
export function useOwnerCandidates(
  conversationId: string,
  currentUser: unknown,
  enabled = true,
) {
  const { data } = useQueryNoThrow(
    api.sessionOwnership.listOwnerCandidates,
    enabled && shouldQueryOwners(conversationId, currentUser)
      ? { session_id: conversationId }
      : "skip",
  );
  return data?.team_members;
}

export function useOwners(conversationId: string, env: OwnersEnv) {
  const { teamMembers, currentUser, notify } = env;

  // useQueryNoThrow: listOwners is enrichment (chips, the handoff banner). A
  // timeout or auth miss must not unmount ConversationView — that is what
  // useQuery does with a terminal server error.
  const { data } = useQueryNoThrow(
    api.sessionOwnership.listOwners,
    shouldQueryOwners(conversationId, currentUser) ? { session_id: conversationId } : "skip",
  );
  const addOwner = useMutation(api.sessionOwnership.addSessionOwner);
  const removeOwner = useMutation(api.sessionOwnership.removeSessionOwner);
  const ackAssignment = useMutation(api.sessionOwnership.ackSessionAssignment);

  // In-flight optimistic overrides: user_id -> desired membership. Each entry is
  // dropped once the reactive query confirms it (reconcile effect), so the chip
  // never flickers back to the server value mid-round-trip.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const serverIds = useMemo(
    () => new Set((data?.owners ?? []).map((o: OwnerInfo) => o.user_id)),
    [data],
  );
  const ownerIds = useMemo(() => {
    const s = new Set(serverIds);
    for (const [id, want] of Object.entries(overrides)) want ? s.add(id) : s.delete(id);
    return s;
  }, [serverIds, overrides]);

  const roster: any[] = useMemo(() => teamMembers ?? [], [teamMembers]);

  const memberById = useMemo(() => {
    const m = new Map<string, any>();
    for (const mem of roster) if (mem?._id) m.set(mem._id, mem);
    return m;
  }, [roster]);

  const displayFor = (id: string) => {
    const mem = memberById.get(id);
    const info = (data?.owners ?? []).find((o: OwnerInfo) => o.user_id === id);
    const name =
      mem?.name || info?.name || mem?.email?.split("@")[0] || info?.email?.split("@")[0] || "Teammate";
    return { name, image: mem?.image || mem?.github_avatar_url };
  };

  // Once the server reflects an override's desired state, drop it.
  useWatchEffect(() => {
    setOverrides((o) => {
      let changed = false;
      const n = { ...o };
      for (const [id, want] of Object.entries(o)) {
        if (serverIds.has(id) === want) { delete n[id]; changed = true; }
      }
      return changed ? n : o;
    });
  }, [serverIds]);

  const toggle = async (id: string, note?: string) => {
    const wasOwner = ownerIds.has(id);
    const disp = displayFor(id);
    setOverrides((o) => ({ ...o, [id]: !wasOwner })); // optimistic
    try {
      if (wasOwner) {
        await removeOwner({ session_id: conversationId, owner: id });
      } else {
        await addOwner({ session_id: conversationId, owner: id, note: note?.trim() || undefined });
        notify?.(`Assigned to ${disp.name}`, "success");
      }
      // Leave the override; the reconcile effect clears it when the query catches up.
    } catch (e: any) {
      setOverrides((o) => { const n = { ...o }; delete n[id]; return n; }); // revert
      notify?.(humanizeConvexError(e, "Owner change failed"), "error");
    }
  };

  const clearAll = async () => {
    const ids = Array.from(ownerIds);
    setOverrides((o) => { const n = { ...o }; for (const id of ids) n[id] = false; return n; });
    try {
      for (const id of ids) await removeOwner({ session_id: conversationId, owner: id });
    } catch (e: any) {
      notify?.(humanizeConvexError(e, "Failed to clear owners"), "error");
    }
  };

  // Bots (Mr Bot, Anchors) can't own a session — a bot's inbox is nobody's.
  const selectable = roster.filter((m: any) => m && !m.is_bot);
  const ownerList = Array.from(ownerIds);

  // The current user's own UNACKED handoff (someone else assigned them, no
  // seen_at) — drives the "assigned to you" banner. Locally-acked state hides
  // it instantly while the mutation round-trips.
  const [ackedLocally, setAckedLocally] = useState(false);
  const meId = currentUser?._id?.toString?.();
  const myRow = meId ? (data?.owners ?? []).find((o: OwnerInfo) => o.user_id === meId) : undefined;
  // The handoff: my owner row when someone ELSE added me. Outlives the ack —
  // the conversation marks where in the timeline the handoff landed for as
  // long as I own the session, not just until I press "Got it".
  const handoff = myRow && myRow.added_by && myRow.added_by !== meId ? myRow : null;
  const myAssignment = !ackedLocally && handoff && !handoff.seen_at ? handoff : null;
  const ack = async () => {
    setAckedLocally(true);
    try {
      await ackAssignment({ session_id: conversationId });
    } catch {
      setAckedLocally(false);
    }
  };

  return { ownerIds, ownerList, displayFor, toggle, clearAll, selectable, currentUser, handoff, myAssignment, ack };
}

export type OwnersApi = ReturnType<typeof useOwners>;
