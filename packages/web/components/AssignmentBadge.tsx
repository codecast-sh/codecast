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

import { Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import {
  useDevices,
  deviceDisplayName,
  deviceKindLabel,
  relativeSeen,
  DeviceIcon,
  DeviceDot,
  RunOnDeviceItems,
} from "./DeviceBadge";
import { useOwnersFromStore, OwnerAvatar, OwnerMenuItems } from "./OwnersBadge";

/** Per-kind accent tint for the device lobe (text+bg only — the pill owns the border). */
function deviceTint(d: { is_remote: boolean; platform: string } | undefined): string {
  if (!d) return "bg-sol-bg-highlight/40 text-sol-text-dim";
  if (d.is_remote) return "bg-sol-violet/10 text-sol-violet";
  if (/linux/i.test(d.platform)) return "bg-sol-orange/10 text-sol-orange";
  return "bg-sol-blue/10 text-sol-blue";
}

export function AssignmentBadge({
  conversationId,
  ownerDeviceId,
}: {
  conversationId: string;
  ownerDeviceId?: string | null;
}) {
  const { byId, loaded } = useDevices();
  const owners = useOwnersFromStore(conversationId);
  const d = ownerDeviceId ? byId.get(ownerDeviceId) : undefined;
  const { ownerList, displayFor } = owners;

  const deviceTitle = d
    ? `Runs on ${deviceDisplayName(d)} (${deviceKindLabel(d)}) — ${d.online ? "online" : `last seen ${relativeSeen(d.last_seen)}`}`
    : "No device assigned yet — the next message routes to your most-recently-active machine.";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`${deviceTitle}\nOwners — whose inboxes this session appears in.`}
          className="inline-flex items-stretch rounded-full border border-sol-border/40 overflow-hidden text-[10px] font-medium outline-none transition-colors hover:border-sol-border/80"
        >
          {loaded && (
            <span className={`inline-flex items-center gap-1 pl-2 pr-1.5 py-0.5 max-w-[150px] ${deviceTint(d)}`}>
              {d ? (
                <>
                  <DeviceIcon d={d} />
                  <span className="truncate">{deviceDisplayName(d)}</span>
                  <DeviceDot online={d.online} />
                </>
              ) : (
                <>
                  <DeviceDot online={false} />
                  <span>Unassigned</span>
                </>
              )}
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1.5 pl-1.5 pr-2 py-0.5 max-w-[150px] ${
              ownerList.length
                ? "bg-sol-cyan/10 text-sol-cyan"
                : "text-sol-text-dim hover:text-sol-text"
            }`}
          >
            {ownerList.length ? (
              <>
                <span className="flex -space-x-1.5">
                  {ownerList.slice(0, 3).map((id) => {
                    const disp = displayFor(id);
                    return <OwnerAvatar key={id} name={disp.name} image={disp.image} />;
                  })}
                </span>
                <span className="truncate">
                  {ownerList.length === 1 ? displayFor(ownerList[0]).name : `${ownerList.length} owners`}
                </span>
              </>
            ) : (
              <>
                <Users className="w-3 h-3" />
                <span>Assign</span>
              </>
            )}
          </span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        <RunOnDeviceItems conversationId={conversationId} ownerDeviceId={ownerDeviceId} />
        <DropdownMenuSeparator />
        <OwnerMenuItems owners={owners} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
