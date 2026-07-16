"use client";

/**
 * The OWNERS axis of a session — the SET of teammates whose inboxes it appears
 * in and who receive its notifications. This is the platform-free core shared
 * by the web AssignmentBadge and the mobile AssignmentChip: it owns the live
 * listOwners query and the optimistic in-flight overrides, and exposes toggle /
 * clearAll / display helpers.
 *
 * MOBILE-SAFE by construction: this file is bundled into the Expo app, so no
 * DOM, no sonner, no window/document (see shared-code Hermes traps). The
 * environment injects what differs per platform: the team roster + current
 * user (web reads the inbox store; mobile queries convex per screen) and a
 * notify callback (web: sonner toast; mobile: the session screen's toast).
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { isConvexId } from "../lib/entityLinks";
import { useWatchEffect } from "./useWatchEffect";

type OwnerInfo = { user_id: string; name: string | null; email: string | null };

export type OwnersEnv = {
  teamMembers: any[] | undefined;
  currentUser: any;
  notify?: (msg: string, kind: "success" | "error") => void;
};

export function useOwners(conversationId: string, env: OwnersEnv) {
  const { teamMembers, currentUser, notify } = env;

  // Live owner set for THIS open session. Skipped while the row is an
  // optimistic stub (client UUID, no server row yet) — the query resolves null
  // for a ref the server doesn't know, so there's nothing to fetch until the
  // real id syncs back and re-keys the row.
  const data = useQuery(
    api.sessionOwnership.listOwners,
    conversationId && isConvexId(conversationId) ? { session_id: conversationId } : "skip",
  );
  const addOwner = useMutation(api.sessionOwnership.addSessionOwner);
  const removeOwner = useMutation(api.sessionOwnership.removeSessionOwner);

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

  const memberById = useMemo(() => {
    const m = new Map<string, any>();
    for (const mem of teamMembers || []) if (mem?._id) m.set(mem._id, mem);
    return m;
  }, [teamMembers]);

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

  const toggle = async (id: string) => {
    const wasOwner = ownerIds.has(id);
    const disp = displayFor(id);
    setOverrides((o) => ({ ...o, [id]: !wasOwner })); // optimistic
    try {
      if (wasOwner) {
        await removeOwner({ session_id: conversationId, owner: id });
      } else {
        await addOwner({ session_id: conversationId, owner: id });
        notify?.(`Assigned to ${disp.name}`, "success");
      }
      // Leave the override; the reconcile effect clears it when the query catches up.
    } catch (e: any) {
      setOverrides((o) => { const n = { ...o }; delete n[id]; return n; }); // revert
      notify?.(e?.message || "Owner change failed", "error");
    }
  };

  const clearAll = async () => {
    const ids = Array.from(ownerIds);
    setOverrides((o) => { const n = { ...o }; for (const id of ids) n[id] = false; return n; });
    try {
      for (const id of ids) await removeOwner({ session_id: conversationId, owner: id });
    } catch (e: any) {
      notify?.(e?.message || "Failed to clear owners", "error");
    }
  };

  // Bots (Mr Bot, Anchors) can't own a session — a bot's inbox is nobody's.
  const selectable = (teamMembers || []).filter((m: any) => m && !m.is_bot);
  const ownerList = Array.from(ownerIds);

  return { ownerIds, ownerList, displayFor, toggle, clearAll, selectable, currentUser };
}

export type OwnersApi = ReturnType<typeof useOwners>;
