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
import { ArrowRightLeft, Archive, Briefcase, CheckCircle2, CircleDot, Lock, Moon, Square, Tag, Users, X } from "lucide-react";
import { DeviceDot, DeviceIcon, RUNNING_HERE_ROW, RunningHereTag, deviceDisplayName, deviceWakesOnUse } from "./DeviceBadge";
import { useBulkMoveSessions, useMoveTargets } from "../hooks/useBulkMoveSessions";
import { CtxHeader, CtxItem, CtxMenuClose, CtxSeparator, CtxSub, CtxSubContent, CtxSubTrigger } from "./ui/context-menu";
import { useInboxStore, isConvexId, sortLabels, type InboxSession } from "../store/inboxStore";
import { getLabelColor } from "../lib/labelColors";
import { labelSessions } from "../lib/labelSessions";
import { fileSessionsAsRest } from "../store/undoActions";
import { useMenuTarget } from "../lib/hoverTarget";
import { SwitchReview } from "./consequential/ConsequentialSwitch";
import { killReviewOf } from "./consequential/killReview";
import { moveSessionsToWorkspace, planWorkspaceMove, workspaceMoveLedgerFor } from "../lib/workspaceMove";
import type { TaskRow } from "./triggerTasks";

/** The device rows of a "Move to…" submenu: laptops, team machines, then cloud hosts. */
export function MoveToDeviceItems({ sessions, onDone }: { sessions: any[]; onDone?: () => void }) {
  const { locals, team, remotes, all: rows, loaded } = useMoveTargets();
  const move = useBulkMoveSessions();
  const everyOwner = sessions.length && sessions.every((s) => s.owner_device_id === sessions[0]?.owner_device_id) ? sessions[0]?.owner_device_id : null;
  if (!loaded) return <CtxItem disabled>Loading machines…</CtxItem>;
  if (rows.length === 0) return <CtxItem disabled>No machines — run the codecast daemon on one first</CtxItem>;
  return (
    <>
      {rows.map((d, i) => {
        const here = d.device_id === everyOwner;
        const usable = d.online || (d.is_remote && deviceWakesOnUse(d));
        const note = d.online ? "" : usable ? "asleep — wakes on move" : "offline";
        const runner = (d as { runner_name?: string | null }).runner_name;
        return (
          <React.Fragment key={d.device_id}>
            {i > 0 && (i === locals.length || i === locals.length + team.length) && <CtxSeparator />}
            <CtxItem
              disabled={here || !usable}
              className={here ? RUNNING_HERE_ROW : undefined}
              leading={<DeviceIcon d={d} className={`w-3.5 h-3.5 ${d.is_remote ? "text-sol-violet" : "text-sol-blue"}`} />}
              trailing={here ? <RunningHereTag online={d.online} /> : (
                <span className="ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap text-meta text-sol-text-dim">
                  {note}
                  <DeviceDot online={d.online} />
                </span>
              )}
              onSelect={() => { void move(sessions, d); onDone?.(); }}
            >
              {deviceDisplayName(d)}{runner ? ` · ${runner}` : ""}
            </CtxItem>
          </React.Fragment>
        );
      })}
    </>
  );
}


/** The workspace rows of a "Move to…" menu: each of my teams, then Personal
 *  (lib/workspaceMove). Into a team widens who reads them, so it opens the
 *  review; to Personal narrows it and is one press. */
export function MoveToWorkspaceItems({ sessions, onDone }: { sessions: any[]; onDone?: () => void }) {
  const teams = useInboxStore((s) => s.teams) as Array<{ _id: string; name?: string }>;
  const [reviewing, setReviewing] = React.useState<{ _id: string; name: string } | null>(null);
  const move = (teamId: string | null, name: string) => { setReviewing(null); moveSessionsToWorkspace(sessions, teamId, name); onDone?.(); };
  if (planWorkspaceMove(sessions, null).own.length === 0) return <CtxItem disabled>Only your own sessions move between workspaces</CtxItem>;
  const row = (teamId: string | null, name: string, icon: React.ComponentType<{ className?: string }>) => {
    const here = planWorkspaceMove(sessions, teamId).movers.length === 0;
    return (
      <CtxItem
        key={teamId ?? "personal"}
        icon={icon}
        disabled={here}
        trailing={here ? <span className="ml-2 text-meta text-sol-text-dim">Here</span> : undefined}
        // The review is mounted by this menu, so the menu stays open behind it.
        onSelect={(e) => { if (teamId) { e.preventDefault(); setReviewing({ _id: teamId, name }); } else move(null, name); }}
        data-move-workspace={teamId ?? "personal"}
      >
        {name}
      </CtxItem>
    );
  };
  return (
    <>
      {teams.filter((t) => t?._id).map((t) => row(String(t._id), t.name || "Team", Users))}
      {row(null, "Personal", Lock)}
      {reviewing && (
        <SwitchReview
          ledger={workspaceMoveLedgerFor(sessions, reviewing)}
          onClose={() => setReviewing(null)}
          onConfirm={() => move(reviewing._id, reviewing.name)}
        />
      )}
    </>
  );
}

/** "Move to workspace" as a submenu, beside "Move to machine". */
export function MoveToWorkspaceSubmenu({ sessions }: { sessions: any[] }) {
  return (
    <CtxSub>
      <CtxSubTrigger icon={Briefcase}>{sessions.length > 1 ? `Move ${sessions.length} sessions to workspace` : "Move to workspace"}</CtxSubTrigger>
      <CtxSubContent>
        <MoveToWorkspaceItems sessions={sessions} />
      </CtxSubContent>
    </CtxSub>
  );
}

/** The label rows of a "Label…" menu: every label, then remove and new. */
function LabelItems({ sessions, onDone }: { sessions: any[]; onDone?: () => void }) {
  const labels = React.useMemo(() => sortLabels(useInboxStore.getState().buckets as any), []);
  const apply = (bucketId: string | null) => { labelSessions(sessions.map((s) => s._id), bucketId); onDone?.(); };
  return (
    <>
      {labels.map((b: any) => (
        <CtxItem key={b._id} leading={<span className={`inline-block h-2 w-2 rounded-full ${getLabelColor(b.name || "").dot}`} />} onSelect={() => apply(b._id)}>
          {b.name}
        </CtxItem>
      ))}
      {labels.length > 0 && <CtxSeparator />}
      <CtxItem onSelect={() => apply(null)}>Remove label</CtxItem>
      <CtxItem onSelect={() => useInboxStore.getState().openPalette({ targets: sessions, targetType: "session", mode: "bucket" })}>
        New label…
      </CtxItem>
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
  onClose,
  onKill,
  onClear,
}: {
  sessions: InboxSession[];
  onStash?: (ids: string[]) => void;
  onClose?: (ids: string[]) => void;
  onKill?: (ids: string[]) => void;
  onClear?: () => void;
}) {
  const n = sessions.length;
  // While this menu is open its chords act on the selection it was opened
  // for; one that acts closes the menu and clears the selection, as an item does.
  const closeMenu = React.useContext(CtxMenuClose);
  useMenuTarget(sessions.map((s) => s._id), () => { closeMenu?.(); onClear?.(); }, { verbs: { stash: onStash, close: onClose } });
  return (
    <>
      <CtxHeader title={`${n} sessions selected`} />
      <MoveToDeviceSubmenu sessions={sessions} />
      <MoveToWorkspaceSubmenu sessions={sessions} />
      <CtxItem
        icon={ArrowRightLeft}
        onSelect={() => useInboxStore.getState().openPalette({ targets: sessions, targetType: "session", mode: "device" })}
      >
        Move {n} sessions…
      </CtxItem>
      <CtxSub>
        <CtxSubTrigger icon={Tag}>Label {n} sessions</CtxSubTrigger>
        <CtxSubContent>
          <LabelItems sessions={sessions} />
        </CtxSubContent>
      </CtxSub>
      <CtxSeparator />
      <CtxItem icon={CheckCircle2} onSelect={() => { fileSessionsAsRest(sessions.map((s) => s._id), "done"); onClear?.(); }}>
        Mark {n} done
      </CtxItem>
      <CtxItem icon={CircleDot} onSelect={() => { fileSessionsAsRest(sessions.map((s) => s._id), "needs_input"); onClear?.(); }}>
        Mark {n} needs you
      </CtxItem>
      <CtxItem icon={Moon} onSelect={() => { fileSessionsAsRest(sessions.map((s) => s._id), "dormant"); onClear?.(); }}>
        Mark {n} dormant
      </CtxItem>
      <CtxSeparator />
      {onStash && (
        <CtxItem icon={Archive} onSelect={() => { onStash(sessions.map((s) => s._id)); onClear?.(); }}>
          Stash {n} sessions
        </CtxItem>
      )}
      {onClose && (
        <CtxItem icon={X} shortcut="session.close" onSelect={() => { onClose(sessions.map((s) => s._id)); onClear?.(); }}>
          Close {n} sessions
        </CtxItem>
      )}
      {onKill && (
        <KillSelection sessions={sessions} onKill={onKill} onClear={() => onClear?.()} item />
      )}
      {onClear && (
        <>
          <CtxSeparator />
          <CtxItem onSelect={onClear}>Clear selection <span className="ml-auto text-meta text-sol-text-dim">Esc</span></CtxItem>
        </>
      )}
    </>
  );
}

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { CTX_SURFACE } from "./ui/context-menu";
import { KeyCap } from "./KeyboardShortcutsHelp";

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
  onStash?: (ids: string[]) => void;
  onKill?: (ids: string[]) => void;
  onClear: () => void;
}) {
  const n = sessions.length;
  return (
    // The verbs wrap onto a second line on a narrow rail instead of running
    // past its edge (the rail clips): at the usual widths Kill and Done
    // were the ones cut off.
    <div data-sel-bar className="flex flex-wrap items-center gap-x-1.5 gap-y-1 whitespace-nowrap border-b border-sol-border/30 bg-sol-bg px-2.5 py-1.5 text-xs text-sol-text" title="⌘-click toggles a card, shift-click selects a run">
      <span className="font-semibold">{n} selected</span>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sol-text hover:bg-sol-bg-highlight">
              <ArrowRightLeft className="h-3 w-3" /> Move to…
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={CTX_SURFACE}>
            <CtxHeader title="Workspace" />
            <MoveToWorkspaceItems sessions={sessions} onDone={onClear} />
            <CtxSeparator />
            <CtxHeader title="Machine" />
            <MoveToDeviceItems sessions={sessions} onDone={onClear} />
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sol-text hover:bg-sol-bg-highlight">
              <Tag className="h-3 w-3" /> Label
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className={CTX_SURFACE}>
            <LabelItems sessions={sessions} onDone={onClear} />
          </DropdownMenuContent>
        </DropdownMenu>
        {onStash && (
          <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sol-text hover:bg-sol-bg-highlight" onClick={() => { onStash(sessions.map((s) => s._id)); onClear(); }}>
            <Archive className="h-3 w-3" /> Stash
          </button>
        )}
        {onKill && (
          <KillSelection sessions={sessions} onKill={onKill} onClear={onClear} />
        )}
        <button type="button" title="Leave selection" className="ml-1.5 inline-flex items-center gap-1.5 rounded bg-sol-text px-2 py-0.5 font-semibold text-sol-bg hover:opacity-90" onClick={onClear}>
          Done <KeyCap size="xs">Esc</KeyCap>
        </button>
      </div>
    </div>
  );
}

/** Kill for one session or a selection: it ends at once (restore brings it
 *  back) unless it would cut a turn off or cancel a trigger or a queued
 *  message, which opens the review first (killReviewOf). */
export function KillSelection({ sessions, onKill, onClear, item, label }: {
  sessions: InboxSession[];
  onKill: (ids: string[]) => void;
  onClear: () => void;
  /** Drawn as a context menu item, which stays open behind the review. */
  item?: boolean;
  label?: string;
}) {
  const [reviewing, setReviewing] = React.useState(false);
  const kill = () => { setReviewing(false); onKill(sessions.map((s) => s._id)); onClear(); };
  const review = killReviewOf(sessions, Object.values(useInboxStore.getState().agentTasks ?? {}) as TaskRow[]);
  const asks = !!review;
  return (
    <>
      {item ? (
        // Keeping the menu open while the review shows keeps this item, and the review it owns, mounted.
        <CtxItem danger icon={Square} onSelect={(e) => { if (asks) { e.preventDefault(); setReviewing(true); } else kill(); }} data-bulk-kill>
          {label ?? `Kill ${sessions.length} sessions`}
        </CtxItem>
      ) : (
        <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sol-red hover:bg-sol-bg-highlight" onClick={() => (asks ? setReviewing(true) : kill())} aria-haspopup={asks ? "dialog" : undefined} data-bulk-kill>
          <Square className="h-3 w-3" /> Kill
        </button>
      )}
      {reviewing && review && (
        <SwitchReview
          ledger={review}
          onClose={() => setReviewing(false)}
          onConfirm={kill}
        />
      )}
    </>
  );
}
