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

import { useMemo, useState, useSyncExternalStore } from "react";
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
  image?: string | null;
  added_by_image?: string | null;
};

/**
 * One handoff as the transcript draws it: who passed the session to whom, when,
 * and the note they wrote. Derived from the owner row the handoff created (a
 * self-claim is not a handoff), plus an optimistic entry for a transfer still
 * in flight so the marker lands the instant the composer clears.
 */
export type HandoffInfo = {
  to: string;
  to_name: string;
  to_image?: string | null;
  from: string;
  from_name: string;
  from_image?: string | null;
  at: number;
  note: string | null;
  seen: boolean;
  pending?: boolean;
};

// In-flight handoffs, shared by every useOwners instance on a conversation:
// the composer writes one when a teammate is picked and the transcript (a
// separate instance) draws it the same frame. Module state, not the inbox
// store — it lives only until the server row echoes back.
const pendingHandoffsByConv = new Map<string, Record<string, HandoffInfo>>();
const pendingListeners = new Set<() => void>();
const EMPTY_PENDING: Record<string, HandoffInfo> = {};
function setPendingHandoffs(conversationId: string, update: (p: Record<string, HandoffInfo>) => Record<string, HandoffInfo>) {
  const prev = pendingHandoffsByConv.get(conversationId) ?? EMPTY_PENDING;
  const next = update(prev);
  if (next === prev) return;
  if (Object.keys(next).length === 0) pendingHandoffsByConv.delete(conversationId);
  else pendingHandoffsByConv.set(conversationId, next);
  for (const l of pendingListeners) l();
}
function usePendingHandoffs(conversationId: string): Record<string, HandoffInfo> {
  return useSyncExternalStore(
    (l) => { pendingListeners.add(l); return () => { pendingListeners.delete(l); }; },
    () => pendingHandoffsByConv.get(conversationId) ?? EMPTY_PENDING,
    () => EMPTY_PENDING,
  );
}

/** How the owner set was changed, for a `reparent` binding that reaches the one
 *  reparent core (org-staffing.md S11). `add` re-homes under the added person,
 *  `set` under the LAST listed (callers put the named person last), `remove`
 *  leaves the line to whoever remains;
 *  a role files the session under the role. */
export type OwnerReparentTarget =
  | { kind: "user"; owners: string[]; mode: "set" | "add" | "remove" }
  | { kind: "role"; role_id: string };

/**
 * The owner set a hand-off sends, in the order the core reads it.
 *
 * The person the hand-off NAMES must come last, because
 * performReparentSession takes the LAST owner as the session's new reporting
 * parent. A Set keeps insertion order and re-adding a member already in it does
 * not move it, so handing a thread to someone who is ALREADY a co-owner would
 * otherwise leave the reporting line with whoever happened to be last, filing
 * the thread under the wrong person. Deleting before adding moves them to the
 * end. `keepSelf` decides whether the person handing it over stays an owner.
 */
export function handoffOwnerSet(ownerIds: Iterable<string>, to: string, meId?: string, keepSelf = false): string[] {
  const desired = new Set(ownerIds);
  if (!keepSelf && meId && meId !== to) desired.delete(meId);
  desired.delete(to);
  desired.add(to);
  return Array.from(desired);
}

export type OwnersEnv = {
  // Warm-paint fallback roster only: the picker overlays the SESSION team's
  // members via listOwnerCandidates (subscribed only while the menu is open).
  teamMembers: any[] | undefined;
  currentUser: any;
  notify?: (msg: string, kind: "success" | "error") => void;
  // The store binding (org-staffing.md S11, built by useStoreOwnersEnv for web
  // and mobile alike): route every owner change through the org store's
  // reparentOrgSession so the chart node moves in the same tick and one
  // dispatch reaches the core. It owns its own toast (the "now reports to"
  // line from the told counts, or the fallback for a plain remove/clear).
  // A caller that only reads (the mobile handoff banner) leaves it absent.
  reparent?: (target: OwnerReparentTarget, opts: { note?: string; parentName?: string; toastFallback?: string }) => Promise<void>;
  // Human who started the session (author, else runner). When the owner set
  // is empty the chip and menu treat them as the owner — a person who started
  // a thread already owns it, even before a session_owners row exists.
  implicitOwnerId?: string;
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
  const { teamMembers, currentUser, notify, implicitOwnerId } = env;

  // useQueryNoThrow: listOwners is enrichment (chips, the handoff banner). A
  // timeout or auth miss must not unmount ConversationView — that is what
  // useQuery does with a terminal server error.
  const { data, error } = useQueryNoThrow(
    api.sessionOwnership.listOwners,
    shouldQueryOwners(conversationId, currentUser) ? { session_id: conversationId } : "skip",
  );
  const addOwner = useMutation(api.sessionOwnership.addSessionOwner);
  const removeOwner = useMutation(api.sessionOwnership.removeSessionOwner);
  const setOwners = useMutation(api.sessionOwnership.setSessionOwners);
  const ackAssignment = useMutation(api.sessionOwnership.ackSessionAssignment);

  // In-flight optimistic overrides: user_id -> desired membership. Each entry is
  // dropped once the reactive query confirms it (reconcile effect), so the chip
  // never flickers back to the server value mid-round-trip.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  // In-flight handoffs (assignee -> the marker to draw), dropped once the
  // server's owner row carries this handoff (same assigner, stamped no earlier).
  const pendingHandoffs = usePendingHandoffs(conversationId);

  const serverIds = useMemo(
    () => new Set((data?.owners ?? []).map((o: OwnerInfo) => o.user_id)),
    [data],
  );
  const ownerIds = useMemo(() => {
    const s = new Set(serverIds);
    for (const [id, want] of Object.entries(overrides)) want ? s.add(id) : s.delete(id);
    if (s.size === 0 && implicitOwnerId && overrides[implicitOwnerId] !== false) s.add(implicitOwnerId);
    return s;
  }, [serverIds, overrides, implicitOwnerId]);

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
    return { name, image: mem?.image || mem?.github_avatar_url || info?.image || undefined };
  };

  const meId = currentUser?._id?.toString?.();

  // Every handoff the owner rows record, oldest first, with in-flight ones
  // overlaid by assignee. Visible to every viewer: the transcript marks where
  // each transfer landed, not just the current user's own.
  const handoffs: HandoffInfo[] = useMemo(() => {
    const byTo = new Map<string, HandoffInfo>();
    for (const o of data?.owners ?? []) {
      if (!o.added_by || o.added_by === o.user_id || !o.added_at) continue;
      const from = memberById.get(o.added_by);
      const to = memberById.get(o.user_id);
      byTo.set(o.user_id, {
        to: o.user_id,
        to_name: to?.name || o.name || to?.email?.split("@")[0] || o.email?.split("@")[0] || "Teammate",
        to_image: to?.image || to?.github_avatar_url || o.image,
        from: o.added_by,
        from_name: from?.name || o.added_by_name || from?.email?.split("@")[0] || "A teammate",
        from_image: from?.image || from?.github_avatar_url || o.added_by_image,
        at: o.added_at,
        note: o.note ?? null,
        seen: !!o.seen_at,
      });
    }
    for (const [id, h] of Object.entries(pendingHandoffs)) byTo.set(id, h);
    return Array.from(byTo.values()).sort((a, b) => a.at - b.at);
  }, [data, memberById, pendingHandoffs]);

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
    setPendingHandoffs(conversationId, (p) => {
      let changed = false;
      const n = { ...p };
      for (const [id, h] of Object.entries(p)) {
        const row = (data?.owners ?? []).find((o: OwnerInfo) => o.user_id === id);
        if (row && row.added_by === h.from && (row.added_at ?? 0) >= h.at - 60_000) { delete n[id]; changed = true; }
      }
      return changed ? n : p;
    });
  }, [serverIds]);

  const toggle = async (id: string, note?: string) => {
    const wasOwner = ownerIds.has(id);
    const disp = displayFor(id);
    setOverrides((o) => ({ ...o, [id]: !wasOwner })); // optimistic
    try {
      if (env.reparent) {
        // One path (S11): add re-homes under this person (and clears the role);
        // remove leaves the line to whoever remains. The binding toasts.
        await env.reparent(
          { kind: "user", owners: [id], mode: wasOwner ? "remove" : "add" },
          wasOwner ? { toastFallback: `Removed ${disp.name}` } : { note, parentName: disp.name },
        );
      } else if (wasOwner) {
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

  /** File the session under a role (S11): the chart's role move, from the menu.
   *  Clears the person-owner line the way the chart drop onto a role does. */
  const moveToRole = async (roleId: string, roleName: string) => {
    if (!env.reparent) return;
    try {
      await env.reparent({ kind: "role", role_id: roleId }, { parentName: roleName, toastFallback: `Filed under ${roleName}` });
    } catch (e: any) {
      notify?.(humanizeConvexError(e, "Move to a role failed"), "error");
    }
  };

  /**
   * Hand the session to a teammate with a note, in ONE mutation: the desired
   * set is the current owners plus them, minus me unless `keepSelf`. The note
   * rides the assignee's row (their banner, their notification) and the
   * transcript marker everyone sees. The marker is drawn optimistically so it
   * lands the instant the composer clears.
   */
  const handoffTo = async (id: string, note: string, opts: { keepSelf?: boolean } = {}) => {
    const trimmed = note.trim();
    // The named person goes last; see handoffOwnerSet for why that matters.
    const desired = handoffOwnerSet(ownerIds, id, meId, opts.keepSelf);
    const disp = displayFor(id);
    const me = meId ? displayFor(meId) : { name: "You", image: undefined };
    setOverrides((o) => ({ ...o, [id]: true, ...(!opts.keepSelf && meId ? { [meId]: false } : {}) }));
    if (meId) {
      setPendingHandoffs(conversationId, (p) => ({
        ...p,
        [id]: { to: id, to_name: disp.name, to_image: disp.image, from: meId, from_name: me.name, from_image: me.image, at: Date.now(), note: trimmed || null, seen: false, pending: true },
      }));
    }
    try {
      if (env.reparent) {
        // One path (S11): set the owner line to `desired`, last listed becomes
        // the reporting parent. The binding toasts the "now reports to" line.
        await env.reparent({ kind: "user", owners: desired, mode: "set" }, { note: trimmed, parentName: disp.name, toastFallback: `Handed off to ${disp.name}` });
      } else {
        await setOwners({ session_id: conversationId, owners: desired, note: trimmed || undefined });
        notify?.(`Handed off to ${disp.name}`, "success");
      }
      return true;
    } catch (e: any) {
      setOverrides((o) => { const n = { ...o }; delete n[id]; if (meId) delete n[meId]; return n; });
      setPendingHandoffs(conversationId, (p) => { const n = { ...p }; delete n[id]; return n; });
      notify?.(humanizeConvexError(e, "Handoff failed"), "error");
      return false;
    }
  };

  const clearAll = async () => {
    const ids = Array.from(ownerIds);
    setOverrides((o) => { const n = { ...o }; for (const id of ids) n[id] = false; return n; });
    try {
      if (env.reparent) {
        // One path (S11): an empty set disowns everyone in one call.
        await env.reparent({ kind: "user", owners: [], mode: "set" }, { toastFallback: "Cleared owners" });
      } else {
        for (const id of ids) await removeOwner({ session_id: conversationId, owner: id });
      }
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

  const canManage = error || data === null ? false : data ? true : undefined;
  return { ownerIds, ownerList, implicitOwnerId, displayFor, toggle, moveToRole, handoffTo, handoffs, clearAll, selectable, currentUser, handoff, myAssignment, ack, canManage };
}

export type OwnersApi = ReturnType<typeof useOwners>;
