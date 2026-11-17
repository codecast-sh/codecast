"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { deviceDisplayName, type Device } from "../DeviceBadge";

/**
 * Whether this machine takes any work or is kept for one job (devices.reserved_for).
 * A reserved machine is skipped by every automatic placement: sessions reach it only
 * when someone picks it by name, moves one there, or a line slot sends a run.
 */
export function DeviceReservationControl({ d }: { d: Device }) {
  const setDeviceReservation = useInboxStore((s) => s.setDeviceReservation);
  const [editing, setEditing] = useState(false);
  const [purpose, setPurpose] = useState("");
  const name = deviceDisplayName(d);
  const reserved = d.reserved_for?.trim();

  const reserve = () => {
    const p = purpose.trim();
    if (!p) return;
    setDeviceReservation(d.device_id, p);
    setEditing(false);
    setPurpose("");
    toast.success(`${name} is reserved for ${p}`);
  };
  const open = () => {
    setDeviceReservation(d.device_id, "");
    toast(`${name} takes any work again`);
  };

  return (
    <div
      data-device-reservation
      className={`mt-3 rounded-lg border px-3 py-2.5 transition-colors duration-300 ${
        reserved ? "border-sol-orange/30 bg-sol-orange/[0.06]" : "border-sol-border/60 bg-sol-bg-alt/40"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex items-center gap-1.5 text-meta font-medium text-sol-text-muted">
          {reserved ? <Lock className="h-3 w-3 text-sol-orange" /> : null}
          Placement
        </span>
        {reserved ? (
          <>
            <span className="text-meta text-sol-text">
              Reserved for <span className="font-medium text-sol-orange">{reserved}</span>
            </span>
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-meta" onClick={open}>
              Open to any work
            </Button>
          </>
        ) : editing ? (
          <form
            className="flex flex-1 items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              reserve();
            }}
          >
            <Input
              autoFocus
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
              placeholder="Purpose, e.g. Union line"
              maxLength={60}
              className="h-7 min-w-0 flex-1 text-meta"
            />
            <Button type="submit" size="sm" className="h-7 px-2.5 text-meta" disabled={!purpose.trim()}>
              Reserve
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-meta" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <span className="text-meta text-sol-text-dim">Any work</span>
            <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-meta" onClick={() => setEditing(true)}>
              Reserve
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
