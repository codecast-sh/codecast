// The grant switches of one app, shared by the consent sheet and Settings >
// Installed apps: each permission a row with its name, what it does, and its
// switch. Full access wears the warning color everywhere it appears, and when
// it cannot be had the switch gives way to the reason.
import { Lock, ShieldAlert } from "lucide-react";
import type { AppPermission } from "@codecast/shared/contracts/pageApp";
import { Switch } from "../ui/switch";
import { permissionEffect, permissionLabel, type ConsentToggle } from "../../lib/installedApps";

export function PermissionToggles({ rows, platform, onFlip, highlight, dense, idPrefix }: {
  rows: ConsentToggle[];
  platform: string;
  onFlip: (perm: AppPermission, on: boolean) => void;
  /** Permissions to mark as new in this version. */
  highlight?: ReadonlySet<AppPermission>;
  /** Settings rows: tighter, no outer padding. */
  dense?: boolean;
  idPrefix: string;
}) {
  return (
    <ul className={dense ? "grid gap-x-8 sm:grid-cols-2" : "flex flex-col border-b border-sol-border/60 py-1"} data-permission-toggles>
      {rows.map(({ perm, on, block }) => {
        const full = perm === "full-access";
        const id = `${idPrefix}-${perm}`;
        return (
          <li
            key={perm}
            className={`flex items-center gap-3 ${dense ? "py-1.5" : "px-5 py-2"} ${full && !block ? (dense ? "-mx-2 rounded-md px-2" : "") + " bg-sol-orange/[0.08]" : ""}`}
            data-permission={perm}
            data-permission-on={on ? "true" : "false"}
            data-permission-block={block ?? undefined}
          >
            <span className="min-w-0 flex-1">
              <span id={id} className={`flex items-center gap-1.5 text-[13px] ${full && !block ? "font-semibold text-sol-orange" : block ? "text-sol-text-dim" : "text-sol-text"}`}>
                {full && <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                <span className="truncate">{permissionLabel(perm)}</span>
                {highlight?.has(perm) && <span className="rounded-sm bg-sol-blue/15 px-1 text-mark font-semibold text-sol-blue" data-permission-new>New</span>}
              </span>
              <span className={`block truncate text-meta ${full && !block ? "text-sol-orange/80" : "text-sol-text-muted"}`}>{permissionEffect(perm, platform)}</span>
            </span>
            {block ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-meta text-sol-text-dim" data-permission-reason>
                <Lock className="h-3 w-3" aria-hidden />{block}
              </span>
            ) : (
              <Switch checked={on} onCheckedChange={(next) => onFlip(perm, next)} aria-labelledby={id} className={full && on ? "!bg-sol-orange" : ""} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
