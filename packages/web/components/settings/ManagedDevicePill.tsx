"use client";
// A device's management at a glance: the team that manages it through an MDM,
// or the team whose admins removed it (then it is signed out). For an admin of
// that team the pill opens Managed devices, where the device's row is.
import { ShieldCheck, ShieldOff } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { relativeSeen, type Device } from "../DeviceBadge";

export function ManagedDevicePill({ d }: { d: Device }) {
  const m = d.managed;
  const isAdmin = useInboxStore((s) => !!m && (s.teams ?? []).some((t: any) => t && String(t._id) === m.team_id && t.role === "admin"));
  if (!m) return null;
  const removed = m.state === "removed";
  const Icon = removed ? ShieldOff : ShieldCheck;
  const className = `inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10.5px] ${
    removed ? "border-sol-red/30 text-sol-red" : "border-sol-cyan/30 text-sol-cyan"
  }`;
  const label = removed ? `Removed by ${m.team_name}` : `Managed by ${m.team_name}`;
  const title = removed ? `Signed out ${relativeSeen(m.at)}` : `Enrolled ${relativeSeen(m.at)}`;
  const body = (
    <>
      <Icon className="h-3 w-3" />
      {label}
    </>
  );
  if (!isAdmin) return <span className={className} title={title} data-managed-pill={m.state}>{body}</span>;
  return (
    <button
      type="button"
      onClick={() => useInboxStore.getState().openSettingsModal("managed-devices")}
      className={`${className} hover:bg-sol-bg-highlight/50`}
      title={title}
      data-managed-pill={m.state}
    >
      {body}
    </button>
  );
}
