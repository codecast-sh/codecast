"use client";

/**
 * Web bindings for the OWNERS axis of a session (whose inboxes it appears in).
 * The platform-free logic lives in hooks/useOwners (shared with mobile); this
 * file adds the inbox-store roster + sonner toasts (useOwnersFromStore) and
 * the assigned-to-you banner. The header's owners segment and menu live in
 * OwnersMenu; handing a session to someone is adding them there and making
 * them driver.
 */

import { toast } from "sonner";
import { UserCheck } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useOwners, type OwnersApi, type HandoffInfo } from "../hooks/useOwners";
import { useStoreOwnersEnv } from "../hooks/useOwnersStoreEnv";
import { AvatarImg } from "../lib/avatarCache";
import { formatRelative, formatDateFull } from "../lib/utils";
import { teamMembersOf } from "../lib/activeTeam";

export type { OwnersApi, HandoffInfo };

export function OwnerAvatar({ name, image, size = "w-4 h-4" }: { name: string; image?: string; size?: string }) {
  const initials = name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <AvatarImg
      src={image}
      alt={name}
      className={`${size} rounded-full object-cover`}
      fallback={
        <div className={`${size} rounded-full bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-meta font-medium text-sol-text-muted`}>
          {initials || "?"}
        </div>
      }
    />
  );
}

/** The shared owners logic bound to the web environment: the store roster and
 *  sonner. Every change is the store's applySessionOwners. */
export function useOwnersFromStore(conversationId: string): OwnersApi {
  const teamMembers = useInboxStore(teamMembersOf) as any[];
  const currentUser = useInboxStore((s) => s.currentUser) as any;
  return useOwners(conversationId, useStoreOwnersEnv(conversationId, {
    teamMembers,
    currentUser,
    notify: (msg, kind) => (kind === "success" ? toast.success(msg) : toast.error(msg)),
  }));
}

/**
 * The can't-miss handoff strip shown at the top of an open conversation the
 * current user was assigned by someone ELSE and hasn't acknowledged. Shows the
 * assigner + their optional note; "Got it" acks (server) and clears the inbox
 * row's assigned ping (local-first), so both surfaces retire together.
 */
export function AssignedToYouBanner({ conversationId }: { conversationId: string }) {
  const owners = useOwnersFromStore(conversationId);
  const a = owners.myAssignment;
  if (!a) return null;
  const by = a.added_by_name || "A teammate";
  return (
    <div className="flex items-start gap-2.5 mx-3 my-2 px-3 py-2.5 rounded-lg border border-sol-violet/50 bg-sol-violet/10 shadow-[0_0_12px_rgba(108,113,196,0.15)]">
      <UserCheck className="w-4 h-4 text-sol-violet flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-sol-text">
          {by} assigned this thread to you
          {a.added_at && (
            <span className="font-normal text-sol-text-dim whitespace-nowrap" title={formatDateFull(a.added_at)}>
              {" · "}{formatRelative(a.added_at)}
            </span>
          )}
        </div>
        {a.note && (
          <div className="text-xs text-sol-text-muted mt-0.5 whitespace-pre-wrap break-words">
            “{a.note}”
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          owners.ack();
        }}
        className="flex-shrink-0 px-2.5 py-1 rounded-md text-meta font-medium bg-sol-violet/20 text-sol-violet border border-sol-violet/40 hover:bg-sol-violet/30 transition-colors"
      >
        Got it
      </button>
    </div>
  );
}
