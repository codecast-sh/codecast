"use client";

import { ChevronDown, Monitor } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useAccountPool } from "../../hooks/useSyncAccountPool";
import { DeviceIcon, deviceDisplayName, useDevices } from "../DeviceBadge";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { modernChip } from "../ui/modernLook";

/**
 * Which of your machines run on one of your accounts (convex/accountPool.ts,
 * the personal pool). Every one by default; narrow it to some, or back to the
 * machine that holds it. Teams and the line pool are separate grants
 * (AccountPoolPill). `deviceId`: the machine that holds the account, which
 * always keeps it.
 */
export function AccountMachinesControl({ deviceId, email }: { deviceId: string; email: string }) {
  const key = email.toLowerCase();
  const personal = useAccountPool().find((r) => r.mine && r.email === key && !r.team_id);
  const { devices } = useDevices();
  const setAccountDevices = useInboxStore((s) => s.setAccountDevices);
  if (!personal) return null;
  const others = devices.filter((d) => d.device_id !== deviceId);
  const list = personal.device_ids ?? null;
  const on = (id: string) => list === null || list.includes(id);
  const count = others.filter((d) => on(d.device_id)).length;
  const label = list === null ? "All machines" : count === 0 ? "This machine only" : `${count + 1} machines`;
  const toggle = (id: string) => {
    const current = list ?? others.map((d) => d.device_id);
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    setAccountDevices(email, next.length === others.length ? null : next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-account-machines={key}
          title="Which of your machines run on this account"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-meta transition-colors ${
            list === null ? "border-sol-green/50 bg-sol-green/10 text-sol-text" : "border-sol-yellow/50 bg-sol-yellow/10 text-sol-text"
          } ${modernChip({ active: true })}`}
        >
          <Monitor className="h-3 w-3 shrink-0" />
          <span>{label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[15rem]">
        <DropdownMenuCheckboxItem
          checked={list === null}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(v) => setAccountDevices(email, v ? null : [])}
        >
          All my machines
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {others.map((d) => (
          <DropdownMenuCheckboxItem
            key={d.device_id}
            checked={on(d.device_id)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => toggle(d.device_id)}
          >
            <DeviceIcon d={d} className="mr-1.5 h-3 w-3 shrink-0 text-sol-text-muted" />
            <span className="truncate">{deviceDisplayName(d)}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
