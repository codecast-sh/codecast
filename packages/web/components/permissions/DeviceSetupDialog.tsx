import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { useOsPermissions } from "../../hooks/useOsPermissions";
import { useFirstRunDialog } from "../../lib/firstRunDialogs";
import { isDetachedTabWindow, isElectron } from "../../lib/desktop";
import {
  OS_PERMISSION_KINDS,
  OS_PERMISSIONS,
  isPermissionActionable,
  type OsPermissionKind,
} from "../../lib/osPermissions";
import { PermissionRow } from "./PermissionRow";

// The sign-up moment for a DEVICE. Permissions are per machine and per
// browser, so this runs once per device — not once per account — the first
// time the dashboard opens with a required permission still unset. It asks
// nothing by itself: every OS prompt is behind its own button with the
// reason beside it, which is what keeps a browser from treating the asks as
// spam and a person from clicking "Don't allow" on reflex.
//
// Re-openable from settings (`openDeviceSetup`), and the first-run stamp is
// local to this device on purpose: the synced dismissed bag would let one
// machine's answer silence a fresh one.

const SEEN_KEY = "codecast.deviceSetup.v1";
const OPEN_EVENT = "codecast-device-setup-open";

export function openDeviceSetup(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) != null;
  } catch {
    return true;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch {}
}

export function DeviceSetupDialog() {
  const [open, setOpen] = useState(false);
  const [autoChecked, setAutoChecked] = useState(false);
  const { permissions, refresh } = useOsPermissions();
  // Holds the first-run turn while open; waits for it before opening unasked.
  const { blocked, claim } = useFirstRunDialog("device-setup", open);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // First run: wait for a real read (all-unknown is the pre-read state, and
  // an old shell that stays unknown never opens this), then open once if a
  // required kind is still actionable. Another first-run dialog on screen
  // (the inbox tour) defers the check, not the decision: it re-runs the
  // moment that dialog closes.
  useEffect(() => {
    if (autoChecked || open || blocked) return;
    if (isDetachedTabWindow()) return;
    if (OS_PERMISSION_KINDS.every((k) => permissions[k] === "unknown")) return;
    const needed =
      !seen() &&
      OS_PERMISSION_KINDS.some((k) => OS_PERMISSIONS[k].required && isPermissionActionable(permissions[k]));
    if (needed && !claim()) return;
    setAutoChecked(true);
    if (needed) setOpen(true);
    else if (!seen()) markSeen();
  }, [permissions, autoChecked, open, blocked, claim]);

  const close = () => {
    markSeen();
    setOpen(false);
  };

  const listed = OS_PERMISSION_KINDS.filter((k) => permissions[k] !== "n/a" && permissions[k] !== "unknown");
  const required = listed.filter((k) => OS_PERMISSIONS[k].required);
  const optional = listed.filter((k) => !OS_PERMISSIONS[k].required);
  const allRequiredOn = required.every((k) => permissions[k] === "granted");

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogContent className="max-w-lg bg-sol-card border-sol-border p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-sol-text">
            <ShieldCheck className="h-4 w-4 text-sol-cyan" />
            Set up this {isElectron() ? "Mac" : "browser"}
          </DialogTitle>
          <DialogDescription className="text-sol-base1">
            Codecast works best with these turned on. Each one asks the system once, and you can change any of them later in Settings.
          </DialogDescription>
        </DialogHeader>
        <Section title="Needed" kinds={required} permissions={permissions} onChange={refresh} />
        {optional.length > 0 && (
          <Section title="Optional" kinds={optional} permissions={permissions} onChange={refresh} />
        )}
        <div className="flex items-center justify-between gap-3 border-t border-sol-border/60 px-5 py-3">
          <span className="text-xs text-sol-text-dim">
            {allRequiredOn ? "All set." : "You can finish this later from Settings."}
          </span>
          <Button size="sm" onClick={close}>
            {allRequiredOn ? "Done" : "Later"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  kinds,
  permissions,
  onChange,
}: {
  title: string;
  kinds: OsPermissionKind[];
  permissions: Record<OsPermissionKind, string>;
  onChange: () => void;
}) {
  if (kinds.length === 0) return null;
  return (
    <div className="border-t border-sol-border/60">
      <div className="px-5 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-sol-text-dim">{title}</div>
      <div className="divide-y divide-sol-border/40">
        {kinds.map((k) => (
          <PermissionRow key={k} kind={k} readiness={permissions[k] as any} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}
