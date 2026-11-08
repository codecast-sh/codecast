"use client";
// The two grants chat and calls need on this device, asked in place in the
// setup flow: notifications (a message or a waiting session while Codecast is
// in the background) and the microphone (huddles). Each OS prompt is behind
// its own button, the same request the device-setup dialog makes; a granted
// one settles into a check. Rendering this stamps the dialog as seen, so it
// does not ask again on arrival.
import { Bell, Check, Mic, type LucideIcon } from "lucide-react";
import { useOsPermissions } from "../../hooks/useOsPermissions";
import { useMountEffect } from "../../hooks/useMountEffect";
import { isPermissionActionable, permissionActionLabel, requestOsPermission, type AppPermissionKind } from "../../lib/osPermissions";
import { markDeviceSetupSeen } from "../../lib/deviceSetup";
import { cn } from "../../lib/utils";

const ASKED: { kind: AppPermissionKind; label: string; icon: LucideIcon }[] = [
  { kind: "notifications", label: "Notifications", icon: Bell },
  { kind: "microphone", label: "Microphone", icon: Mic },
];

export function BrowserPermissions() {
  const { permissions, refresh } = useOsPermissions();
  useMountEffect(() => { markDeviceSetupSeen(); });
  const shown = ASKED.filter((p) => permissions[p.kind] !== "n/a" && permissions[p.kind] !== "unknown");
  if (shown.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="This browser">
      {shown.map(({ kind, label, icon: Icon }) => {
        const readiness = permissions[kind];
        const granted = readiness === "granted";
        const action = permissionActionLabel(readiness);
        return (
          <button
            key={kind}
            type="button"
            disabled={granted || !isPermissionActionable(readiness)}
            onClick={() => void requestOsPermission(kind, readiness).finally(refresh)}
            data-permission={kind}
            title={granted ? `${label} on` : action ?? undefined}
            className={cn(
              "tf-ghost inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs",
              granted ? "border-sol-green/40 text-sol-green" : "border-sol-border text-sol-text-muted hover:border-sol-text-muted hover:text-sol-text",
            )}
          >
            {granted ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
            {granted ? `${label} on` : `Allow ${label.toLowerCase()}`}
          </button>
        );
      })}
    </div>
  );
}
