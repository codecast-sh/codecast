import { OPEN_EVENT } from "../../lib/deviceSetup";
import { useCallback, useState, type ReactNode } from "react";
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
  type AppPermissionKind,
  type PermissionMap,
} from "../../lib/osPermissions";
import { ComputerPermissionRows } from "./ComputerPermissionRows";
import { PermissionRow } from "./PermissionRow";

import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
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

  useMountEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  });

  // First run: wait for a real read (all-unknown is the pre-read state, and
  // an old shell that stays unknown never opens this), then open once if a
  // required kind is still actionable. Another first-run dialog on screen
  // (the inbox tour) defers the check, not the decision: it re-runs the
  // moment that dialog closes.
  useWatchEffect(() => {
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
  const requiredOn = required.filter((k) => permissions[k] === "granted").length;
  const allRequiredOn = requiredOn === required.length;

  // The list clips, so a fade over its bottom edge says "more below". It
  // writes a DOM attribute directly: scroll position is not render state.
  // A callback ref, because Radix mounts the content a render after `open`
  // flips, so an effect keyed on `open` would find no list yet. The helper
  // rows arrive seconds after the dialog opens, so the content is observed
  // too, not just the scroll.
  const updateFade = useCallback((list: HTMLDivElement) => {
    const below = list.scrollHeight - list.scrollTop - list.clientHeight > 4;
    list.parentElement!.dataset.canScroll = below ? "true" : "false";
  }, []);
  const listRef = useCallback(
    (list: HTMLDivElement | null) => {
      if (!list) return;
      updateFade(list);
      const ro = new ResizeObserver(() => updateFade(list));
      ro.observe(list);
      if (list.firstElementChild) ro.observe(list.firstElementChild);
      return () => ro.disconnect();
    },
    [updateFade],
  );

  // A flex column capped to the window: the header and the footer stay put,
  // and only the list scrolls. Six rows of reasons do not fit a laptop
  // window, and the way out of the dialog must never scroll away with them.
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogContent className="flex max-h-[min(85vh,760px)] w-[calc(100%-2rem)] max-w-lg flex-col gap-0 overflow-hidden border-sol-border bg-sol-card p-0">
        <DialogHeader className="shrink-0 px-5 pb-4 pt-5 pr-12 text-left sm:text-left">
          <DialogTitle className="flex items-center gap-2 text-sol-text">
            <ShieldCheck className="h-4 w-4 text-sol-cyan" />
            Set up this {isElectron() ? "Mac" : "browser"}
          </DialogTitle>
          <DialogDescription className="text-sol-base1">
            Each one asks the system once. You can change any of them later in Settings.
          </DialogDescription>
          {required.length > 0 && (
            <div className="flex items-center gap-3 pt-3" aria-live="polite">
              <div className="flex flex-1 gap-1" role="img" aria-label={`${requiredOn} of ${required.length} needed on`}>
                {required.map((k) => (
                  <span
                    key={k}
                    className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                      permissions[k] === "granted" ? "bg-sol-green" : "bg-sol-border"
                    }`}
                  />
                ))}
              </div>
              <span className={`text-[11px] tabular-nums ${allRequiredOn ? "text-sol-green" : "text-sol-text-dim"}`}>
                {allRequiredOn ? "Needed: all on" : `${requiredOn} of ${required.length} needed on`}
              </span>
            </div>
          )}
        </DialogHeader>
        <div className="group relative flex min-h-0 flex-1 flex-col border-t border-sol-border/60">
          <div ref={listRef} onScroll={(e) => updateFade(e.currentTarget)} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
            <div>
              <Section title="Needed" kinds={required} permissions={permissions} onChange={refresh} />
              {optional.length > 0 && (
                <Section title="Optional" kinds={optional} permissions={permissions} onChange={refresh}>
                  {/* Mounted with the dialog, so the helper is asked only while
                      someone is looking at the answer. */}
                  <ComputerPermissionRows />
                </Section>
              )}
            </div>
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-sol-card opacity-0 transition-opacity duration-200 group-data-[can-scroll=true]:opacity-100"
          />
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-sol-border/60 px-5 py-3">
          <span className="text-xs text-sol-text-dim">
            {allRequiredOn ? "All set." : "You can finish this later from Settings."}
          </span>
          <Button
            size="sm"
            variant={allRequiredOn ? "default" : "outline"}
            onClick={close}
            className={
              allRequiredOn
                ? "bg-sol-blue text-sol-bg shadow-none hover:bg-sol-blue/90"
                : "border-sol-border bg-transparent text-sol-text shadow-none hover:bg-sol-bg-highlight/60"
            }
          >
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
  children,
}: {
  title: string;
  kinds: AppPermissionKind[];
  permissions: PermissionMap;
  onChange: () => void;
  children?: ReactNode;
}) {
  if (kinds.length === 0) return null;
  return (
    <div className="border-t border-sol-border/60 first:border-t-0">
      {/* Sticky, so a scrolled list still says which group it is in. */}
      <div className="sticky top-0 z-10 bg-sol-card px-5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-sol-text-dim">
        {title}
      </div>
      <div className="divide-y divide-sol-border/40">
        {kinds.map((k) => (
          <PermissionRow key={k} kind={k} readiness={permissions[k]} onChange={onChange} />
        ))}
        {children}
      </div>
    </div>
  );
}
