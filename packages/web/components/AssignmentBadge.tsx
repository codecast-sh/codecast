"use client";

/**
 * The unified assignment control for a session: ONE chip in the conversation
 * header, ONE popover, both movable ownership axes — which machine RUNS it
 * (device) and whose inboxes it lives in (owners). The axes stay independent:
 * moving the device never changes owners and vice versa; they just share a
 * surface instead of being split across two chips and an overflow-menu section.
 *
 * The trigger is a segmented pill — device lobe + owners lobe under one border,
 * each keeping its axis's accent tint. Built on the radix DropdownMenu (like
 * the pieces it unifies) so the panel portals out of the header's
 * overflow-hidden actions row.
 */

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import { useShallow } from "zustand/react/shallow";
import { UserCheck } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import {
  useDevices,
  useForeignOwnerDevice,
  foreignRunnerNote,
  deviceDisplayName,
  deviceKindLabel,
  deviceWakesOnUse,
  relativeSeen,
  DeviceIcon,
  DeviceDot,
  RunOnDeviceItems,
} from "./DeviceBadge";
import { useOwnersFromStore, OwnerAvatar, OwnerMenuItems } from "./OwnersBadge";

type Runner = { id?: string; name: string; image?: string | null };

function RunnerBadge({ runner, compact, title }: { runner: Runner; compact: boolean; title: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] text-sol-text-dim border border-sol-border/40" title={title}>
      <OwnerAvatar name={runner.name} image={runner.image ?? undefined} />
      {!compact && runner.name}
    </span>
  );
}

export function ConversationAssignmentBadge({ conversation, isOwner, guest, compact }: {
  conversation: { _id: string; user_id?: string; owner_device_id?: string | null; user?: { name?: string | null; email?: string | null; avatar_url?: string | null } | null };
  isOwner: boolean;
  guest: boolean;
  compact: boolean;
}) {
  const runner = conversation.user ? {
    id: conversation.user_id,
    name: conversation.user.name || conversation.user.email?.split("@")[0] || "Teammate",
    image: conversation.user.avatar_url,
  } : undefined;
  if (guest) return runner ? <RunnerBadge runner={runner} compact={compact} title="Shared session · read-only access" /> : null;
  return <AssignmentBadge key={conversation._id} conversationId={conversation._id} ownerDeviceId={conversation.owner_device_id} runner={runner} isOwner={isOwner} compact={compact} />;
}

/**
 * Where this session runs, beyond the device: the worktree it was given, and
 * whether the cloud host has it yet. Narrow by design — subscribing to the whole
 * row would re-render the header on every liveness heartbeat (see the wake
 * signature rules in CLAUDE.md); these two fields change once each, at placement.
 */
function useRunLocation(conversationId: string) {
  return useInboxStore(
    useShallow((s) => {
      const row = s.sessions[s.resolveLiveSessionId(conversationId)] ?? s.conversations[conversationId];
      return {
        worktree: row?.worktree_name ?? null,
        preparing: row?.cloud_placement === "pending",
      };
    }),
  );
}

/** Per-kind accent tint for the device lobe (text+bg only — the pill owns the border).
 *  A foreign machine (a teammate's or the agent box — not in the viewer's own
 *  device list, so not re-routable from here) renders dim like the unassigned
 *  state rather than borrowing the viewer's own-device accents. */
function deviceTint(
  d: { is_remote: boolean; platform: string } | undefined,
  foreign = false,
): string {
  if (!d || foreign) return "bg-sol-bg-highlight/40 text-sol-text-dim";
  if (d.is_remote) return "bg-sol-violet/10 text-sol-violet";
  if (/linux/i.test(d.platform)) return "bg-sol-orange/10 text-sol-orange";
  return "bg-sol-blue/10 text-sol-blue";
}

export function AssignmentBadge({
  conversationId,
  ownerDeviceId,
  compact = false,
  isOwner = true,
  runner,
}: {
  conversationId: string;
  ownerDeviceId?: string | null;
  /** Icon-only pill (device icon + dot, avatar — no names) for dense headers
   *  like simple view. The popover keeps the full detail. */
  compact?: boolean;
  isOwner?: boolean;
  runner?: Runner;
}) {
  const { byId, loaded } = useDevices();
  const owners = useOwnersFromStore(conversationId);
  // A session may run on a machine outside the viewer's own device list (a
  // teammate's, or the shared agent box whose daemon authenticates as the bot
  // account) — resolve it via the conversation so the lobe shows its hostname
  // instead of "Unassigned".
  const own = ownerDeviceId ? byId.get(ownerDeviceId) : undefined;
  const foreign = useForeignOwnerDevice(
    conversationId,
    !!ownerDeviceId && !own,
  );
  const d = own ?? (foreign || undefined);
  const { ownerList, displayFor, currentUser } = owners;

  // The default case — no explicit owners (implicitly yours) or just you —
  // renders CONDENSED: avatar only, no name, no "Assign" text. Full names are
  // reserved for the interesting case: the thread living in someone else's inbox.
  const meId = currentUser?._id?.toString?.();
  const isRunner = runner?.id ? runner.id === meId : isOwner;
  const selfOnly =
    (ownerList.length === 0 && isRunner) || (ownerList.length === 1 && ownerList[0] === meId);
  const selfDisp = currentUser
    ? {
        name: currentUser.name || currentUser.email?.split("@")[0] || "You",
        image: currentUser.image || currentUser.github_avatar_url,
      }
    : null;

  const { worktree, preparing } = useRunLocation(conversationId);
  // A machine that boots itself when work arrives reads differently from a
  // laptop: "offline" is its resting state, not a problem, so say so instead of
  // reporting how long ago it was seen.
  const cloudHost = !!d && deviceWakesOnUse(d);
  const deviceTitle = d
    ? `Runs on ${deviceDisplayName(d)} (${cloudHost ? "cloud host, wakes on use" : deviceKindLabel(d)})`
      + `${own || !foreign ? "" : ` — ${foreignRunnerNote(foreign)}`}`
      + `${cloudHost ? "" : ` — ${d.online ? "online" : `last seen ${relativeSeen(d.last_seen)}`}`}`
      + `${worktree ? `\nWorktree ${worktree}` : ""}`
      + `${preparing ? "\nPreparing the host — its worktree is being made now." : ""}`
    : "No machine recorded for this session.";

  if (!(owners.canManage ?? isOwner)) {
    return runner ? <RunnerBadge runner={runner} compact={compact} title={owners.canManage === false ? "Shared session · read-only access" : "Checking assignment permissions"} /> : null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`${deviceTitle}\nOwners — whose inboxes this session appears in.`}
          className="inline-flex items-stretch rounded-full border border-sol-border/40 overflow-hidden text-[10px] font-medium outline-none transition-colors hover:border-sol-border/80"
        >
          {(loaded || d || owners.canManage) && (
            <span className={`inline-flex items-center gap-1 py-0.5 ${compact ? "pl-1.5 pr-1" : `pl-2 pr-1.5 ${worktree || preparing ? "max-w-[260px]" : "max-w-[150px]"}`} ${deviceTint(d, !own && !!foreign)}`}>
              {d ? (
                <>
                  <DeviceIcon d={d} />
                  {!compact && <span className="truncate cq-sq1">{deviceDisplayName(d)}</span>}
                  {!compact && worktree && (
                    <span className="truncate max-w-[70px] font-mono text-[9px] opacity-70 cq-sq1">{worktree}</span>
                  )}
                  {/* While the host is being prepared there is nothing to be
                      online about yet — the dot would read as "offline", which is
                      wrong. Say what is actually happening instead. */}
                  {preparing ? (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap animate-pulse">
                      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />
                      {!compact && <span className="text-[9px] cq-sq1">preparing cloud host</span>}
                    </span>
                  ) : (
                    <DeviceDot online={d.online} />
                  )}
                </>
              ) : (
                <>
                  <DeviceDot online={false} />
                  {!compact && <span className="cq-sq1">{ownerDeviceId ? foreign === undefined ? "Loading machine" : "Unknown machine" : "Unassigned"}</span>}
                </>
              )}
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1.5 py-0.5 ${compact ? "pl-1 pr-1.5" : "pl-1.5 pr-2 max-w-[150px]"} ${
              selfOnly ? "text-sol-text-dim hover:text-sol-text" : "bg-sol-cyan/10 text-sol-cyan"
            }`}
            title={selfOnly ? `Assigned to you${ownerList.length === 0 ? " (default)" : ""} — click to reassign` : undefined}
          >
            {selfOnly ? (
              selfDisp && <OwnerAvatar name={selfDisp.name} image={selfDisp.image} />
            ) : (
              <>
                {ownerList.length === 0 && <UserCheck className="w-3.5 h-3.5" />}
                <span className="flex -space-x-1.5">
                  {ownerList.slice(0, 3).map((id) => {
                    const disp = displayFor(id);
                    return <OwnerAvatar key={id} name={disp.name} image={disp.image} />;
                  })}
                </span>
                {!compact && (
                  <span className="truncate cq-sq1">
                    {ownerList.length === 0 ? "Take ownership" : ownerList.length === 1 ? displayFor(ownerList[0]).name : `${ownerList.length} owners`}
                  </span>
                )}
              </>
            )}
          </span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-[16rem] max-w-[24rem]">
        {runner && <div className="px-2 py-1.5 text-xs text-sol-text-muted">Runs under {runner.name}’s account</div>}
        {!isRunner && <div className="px-2 pb-1.5 text-[10px] text-sol-text-dim">Moving to your machine uses your account and billing.</div>}
        <RunOnDeviceItems conversationId={conversationId} ownerDeviceId={ownerDeviceId} allowRemoteMove={isRunner} />
        <DropdownMenuSeparator />
        <OwnerMenuItems owners={owners} conversationId={conversationId} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
