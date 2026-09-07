"use client";

/**
 * Moving one or many inbox sessions to another machine from a menu — the
 * right-click menu on a card (or a multi-selection) and the ⌘K "Move to
 * device…" mode share this.
 *
 * Two rails, chosen per session:
 *   - laptop ↔ cloud host: the migration batch (convex/sessionMigrations —
 *     fence, wait for the turn, transfer, flip); progress lives in
 *     Settings → Migration.
 *   - laptop → laptop, where the checkout already exists there: the plain
 *     device re-home (devices.reassignToDevice), as "Run on device" does.
 * The split mirrors lib/migrationPlan's eligibility so the menu never offers
 * a move the server would refuse.
 */

import React from "react";
import { toast } from "sonner";
import { ArrowRightLeft, Archive, Square, Tag } from "lucide-react";
import { DeviceDot, DeviceIcon, deviceDisplayName, deviceWakesOnUse, useDevices } from "./DeviceBadge";
import { useBulkMoveSessions } from "../hooks/useBulkMoveSessions";
import { CtxHeader, CtxItem, CtxSeparator, CtxSub, CtxSubContent, CtxSubTrigger } from "./ui/context-menu";
import { useInboxStore, isConvexId, sortLabels, type InboxSession } from "../store/inboxStore";
import { getLabelColor } from "../lib/labelColors";

/** The device rows of a "Move to…" submenu: laptops first, then cloud hosts. */
export function MoveToDeviceItems({ sessions, onDone }: { sessions: any[]; onDone?: () => void }) {
  const { locals, remotes, loaded } = useDevices();
  const move = useBulkMoveSessions();
  const everyOwner = sessions.length && sessions.every((s) => s.owner_device_id === sessions[0]?.owner_device_id) ? sessions[0]?.owner_device_id : null;
  if (!loaded) return <CtxItem disabled>Loading machines…</CtxItem>;
  const rows = [...locals, ...remotes];
  if (rows.length === 0) return <CtxItem disabled>No machines — run the codecast daemon on one first</CtxItem>;
  return (
    <>
      {rows.map((d, i) => {
        const here = d.device_id === everyOwner;
        const usable = d.online || (d.is_remote && deviceWakesOnUse(d));
        const note = here ? "running here" : d.online ? "" : usable ? "asleep — wakes on move" : "offline";
        return (
          <React.Fragment key={d.device_id}>
            {i === locals.length && locals.length > 0 && remotes.length > 0 && <CtxSeparator />}
            <CtxItem
              disabled={here || !usable}
              leading={<DeviceIcon d={d} className={`w-3.5 h-3.5 ${d.is_remote ? "text-sol-violet" : "text-sol-blue"}`} />}
              trailing={
                <span className="ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] text-sol-text-dim">
                  {note}
                  <DeviceDot online={d.online} />
                </span>
              }
              onSelect={() => { void move(sessions, d); onDone?.(); }}
            >
              {deviceDisplayName(d)}
            </CtxItem>
          </React.Fragment>
        );
      })}
    </>
  );
}


/** "Move to…" as a submenu, for the single-session and bulk menus alike. */
export function MoveToDeviceSubmenu({ sessions, label }: { sessions: any[]; label?: string }) {
  return (
    <CtxSub>
      <CtxSubTrigger icon={ArrowRightLeft}>{label ?? (sessions.length > 1 ? `Move ${sessions.length} sessions to` : "Move to machine")}</CtxSubTrigger>
      <CtxSubContent>
        <MoveToDeviceItems sessions={sessions} />
      </CtxSubContent>
    </CtxSub>
  );
}

/**
 * The right-click menu on a MULTI-selection. Deliberately short: the verbs
 * that make sense for N rows at once. Everything single-session stays on the
 * single menu.
 */
export function BulkSessionMenuItems({
  sessions,
  onStash,
  onKill,
  onClear,
}: {
  sessions: InboxSession[];
  onStash?: (id: string) => void;
  onKill?: (id: string) => void;
  onClear?: () => void;
}) {
  const n = sessions.length;
  const labels = React.useMemo(() => sortLabels(useInboxStore.getState().buckets as any), []);
  const applyLabel = (bucketId: string | null, name?: string) => {
    const store = useInboxStore.getState();
    let applied = 0;
    for (const s of sessions) {
      const id = store.getConvexId(s._id) ?? s._id;
      if (!isConvexId(id)) continue;
      store.assignSessionToBucket(id, bucketId);
      applied++;
    }
    toast.success(bucketId ? `Labeled ${applied} session${applied === 1 ? "" : "s"} ${name}` : `Label removed from ${applied}`);
  };
  return (
    <>
      <CtxHeader title={`${n} sessions selected`} />
      <MoveToDeviceSubmenu sessions={sessions} />
      <CtxItem
        icon={ArrowRightLeft}
        onSelect={() => useInboxStore.getState().openPalette({ targets: sessions, targetType: "session", mode: "device" })}
      >
        Move {n} sessions… <span className="ml-auto text-[10px] text-sol-text-dim">⌘K</span>
      </CtxItem>
      <CtxSub>
        <CtxSubTrigger icon={Tag}>Label {n} sessions</CtxSubTrigger>
        <CtxSubContent>
          {labels.map((b: any) => {
            const color = getLabelColor(b.name || "");
            return (
              <CtxItem key={b._id} leading={<span className={`inline-block h-2 w-2 rounded-full ${color.dot}`} />} onSelect={() => applyLabel(b._id, b.name)}>
                {b.name}
              </CtxItem>
            );
          })}
          {labels.length > 0 && <CtxSeparator />}
          <CtxItem onSelect={() => applyLabel(null)}>Remove label</CtxItem>
          <CtxItem onSelect={() => useInboxStore.getState().openPalette({ targets: sessions, targetType: "session", mode: "bucket" })}>
            New label…
          </CtxItem>
        </CtxSubContent>
      </CtxSub>
      <CtxSeparator />
      {onStash && (
        <CtxItem icon={Archive} onSelect={() => { for (const s of sessions) onStash(s._id); onClear?.(); }}>
          Stash {n} sessions
        </CtxItem>
      )}
      {onKill && (
        <CtxItem danger icon={Square} onSelect={() => { for (const s of sessions) onKill(s._id); onClear?.(); }}>
          Kill {n} sessions
        </CtxItem>
      )}
      {onClear && (
        <>
          <CtxSeparator />
          <CtxItem onSelect={onClear}>Clear selection <span className="ml-auto text-[10px] text-sol-text-dim">Esc</span></CtxItem>
        </>
      )}
    </>
  );
}

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { CTX_SURFACE } from "./ui/context-menu";

/**
 * The bar above the inbox list while cards are ticked: the count, the bulk
 * verbs, and the way out. Sits above the header on purpose — it is a mode,
 * not a filter.
 */
export function InboxSelectionBar({
  sessions,
  onStash,
  onKill,
  onClear,
}: {
  sessions: any[];
  onStash?: (id: string) => void;
  onKill?: (id: string) => void;
  onClear: () => void;
}) {
  const n = sessions.length;
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap border-b border-sol-cyan/30 bg-sol-cyan/[0.08] px-2.5 py-1.5 text-xs" title="⌘-click toggles a card, shift-click selects a run">
      <span className="font-medium text-sol-cyan">{n} selected</span>
      <div className="ml-auto flex items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sol-text hover:bg-sol-cyan/15">
              <ArrowRightLeft className="h-3 w-3" /> Move to…
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={CTX_SURFACE}>
            <MoveToDeviceItems sessions={sessions} onDone={onClear} />
          </DropdownMenuContent>
        </DropdownMenu>
        {onStash && (
          <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sol-text hover:bg-sol-cyan/15" onClick={() => { for (const s of sessions) onStash(s._id); onClear(); }}>
            <Archive className="h-3 w-3" /> Stash
          </button>
        )}
        {onKill && (
          <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sol-red hover:bg-sol-red/10" onClick={() => { for (const s of sessions) onKill(s._id); onClear(); }}>
            <Square className="h-3 w-3" /> Kill
          </button>
        )}
        <button type="button" aria-label="Clear selection" title="Clear selection (Esc)" className="rounded px-1 py-0.5 text-sol-text-dim hover:bg-sol-cyan/15 hover:text-sol-text" onClick={onClear}>
          ×
        </button>
      </div>
    </div>
  );
}
