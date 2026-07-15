"use client";

/**
 * The OWNERS axis of a session — the SET of teammates whose inboxes it appears in
 * and who receive its notifications. One of a session's three independent
 * ownership axes; it sits in the conversation header beside DeviceBadge (which
 * machine runs it) and the author chip (who started it). Changing owners never
 * moves the device, and adding an owner notifies them.
 *
 * A compact chip that opens a multi-select of the team roster: each row toggles
 * that teammate on/off. Built on the radix DropdownMenu (like DeviceBadge's move
 * menu) so the panel PORTALS out of the header's overflow-hidden actions row —
 * a hand-rolled absolute panel gets clipped there. Toggles apply optimistically
 * and reconcile against the reactive listOwners query, so the chip never
 * flickers back mid-round-trip.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { Users, X } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useWatchEffect } from "../hooks/useWatchEffect";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
} from "./ui/dropdown-menu";

type OwnerInfo = { user_id: string; name: string | null; email: string | null };

function OwnerAvatar({ name, image, size = "w-4 h-4" }: { name: string; image?: string; size?: string }) {
  if (image) return <img src={image} alt={name} className={`${size} rounded-full object-cover`} />;
  const initials = name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className={`${size} rounded-full bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted`}>
      {initials || "?"}
    </div>
  );
}

export function OwnersBadge({ conversationId }: { conversationId: string }) {
  const teamMembers = useInboxStore((s) => s.teamMembers) as any[];
  const currentUser = useInboxStore((s) => s.currentUser) as any;

  // Live owner set for THIS open session. Gated by the caller to the user's own
  // sessions, where listOwners always resolves (owner access) and never throws.
  const data = useQuery(
    api.sessionOwnership.listOwners,
    conversationId ? { session_id: conversationId } : "skip",
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
        toast.success(`Assigned to ${disp.name}`);
      }
      // Leave the override; the reconcile effect clears it when the query catches up.
    } catch (e: any) {
      setOverrides((o) => { const n = { ...o }; delete n[id]; return n; }); // revert
      toast.error(e?.message || "Owner change failed");
    }
  };

  const clearAll = async () => {
    const ids = Array.from(ownerIds);
    setOverrides((o) => { const n = { ...o }; for (const id of ids) n[id] = false; return n; });
    try {
      for (const id of ids) await removeOwner({ session_id: conversationId, owner: id });
    } catch (e: any) {
      toast.error(e?.message || "Failed to clear owners");
    }
  };

  // Bots (Mr Bot, Anchors) can't own a session — a bot's inbox is nobody's.
  const selectable = (teamMembers || []).filter((m: any) => m && !m.is_bot);
  const ownerList = Array.from(ownerIds);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Owners — whose inboxes this session appears in"
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors outline-none ${
            ownerList.length
              ? "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/30"
              : "border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60"
          }`}
        >
          {ownerList.length ? (
            <>
              <span className="flex -space-x-1.5">
                {ownerList.slice(0, 3).map((id) => {
                  const d = displayFor(id);
                  return <OwnerAvatar key={id} name={d.name} image={d.image} />;
                })}
              </span>
              <span>{ownerList.length === 1 ? displayFor(ownerList[0]).name : `${ownerList.length} owners`}</span>
            </>
          ) : (
            <>
              <Users className="w-3 h-3" />
              <span>Assign owner</span>
            </>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">
          Owners · whose inbox
        </DropdownMenuLabel>
        {selectable.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-sol-text-dim">No teammates</div>
        )}
        {selectable.map((m: any) => {
          const isYou = currentUser && m._id === currentUser._id;
          return (
            <DropdownMenuCheckboxItem
              key={m._id}
              checked={ownerIds.has(m._id)}
              onSelect={(e) => { e.preventDefault(); toggle(m._id); }}
              className="text-xs gap-2"
            >
              <OwnerAvatar name={m.name || m.email || "?"} image={m.image || m.github_avatar_url} />
              <span className="flex-1 truncate">
                {m.name || m.email?.split("@")[0]}
                {isYou ? " (you)" : ""}
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
        {ownerList.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => { e.preventDefault(); clearAll(); }}
              className="text-[11px] text-sol-text-dim focus:text-sol-red gap-1.5"
            >
              <X className="w-3 h-3" /> Clear all owners
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
