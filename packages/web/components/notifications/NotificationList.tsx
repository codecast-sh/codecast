"use client";

// The notification dropdown's panel: header with the unread count, the list
// (waiting bursts folded into one group row), and "View all". Props only; the
// bell feeds it from the store and owns the verbs.

import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { groupIdleNotifications } from "@codecast/shared/contracts";
import { NotificationGroupRow, NotificationRow } from "./NotificationRow";

export function NotificationList({ notifications, unreadCount, onOpen, onContextMenu, onViewAll, openGroups: heldGroups, onToggleGroup, floating = true, className }: {
  // Newest first.
  notifications: any[];
  unreadCount: number;
  onOpen: (n: any) => void;
  onContextMenu?: (e: MouseEvent, n: any) => void;
  onViewAll: () => void;
  // Which folded bursts are open. The bell holds this so it survives closing
  // the dropdown; left out, the list keeps its own.
  openGroups?: Record<string, boolean>;
  onToggleGroup?: (key: string) => void;
  // The bell drops it below the button; false lays it out in place.
  floating?: boolean;
  className?: string;
}) {
  // Fold each waiting burst into one entry (the same fold-up the hourly alert
  // makes), then take 20 ENTRIES — so a fleet of twenty sessions no longer
  // pushes everything else out of the list.
  const entries = useMemo(
    () => groupIdleNotifications(notifications, (n: any) => String(n._id)).slice(0, 20),
    [notifications]
  );
  const [ownGroups, setOwnGroups] = useState<Record<string, boolean>>({});
  const ownToggle = useCallback(
    (key: string) => setOwnGroups((prev) => ({ ...prev, [key]: !prev[key] })),
    []
  );
  const openGroups = heldGroups ?? ownGroups;
  const toggleGroup = onToggleGroup ?? ownToggle;

  return (
    <div className={`${floating ? "cc-topbar-menu absolute right-0 mt-2 w-[calc(100vw-1rem)] sm:w-[520px] max-w-[520px] " : ""}bg-sol-bg border border-sol-border rounded-lg shadow-lg overflow-hidden${floating ? " z-50" : ""}${className ? ` ${className}` : ""}`}>
      <div className="px-5 py-3 border-b border-sol-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-sol-text">Notifications</h3>
        {unreadCount !== undefined && unreadCount > 0 && (
          <span className="text-xs text-sol-text-muted">{unreadCount} unread</span>
        )}
      </div>

      <div className="max-h-[600px] overflow-y-auto">
        {entries.length === 0 ? (
          <div className="px-5 py-12 text-center text-sol-text-muted">
            No notifications yet
          </div>
        ) : (
          entries.map((entry: any) =>
            entry.kind === "group" ? (
              <NotificationGroupRow
                key={entry.key}
                group={entry}
                open={!!openGroups[entry.key]}
                onToggle={() => toggleGroup(entry.key)}
                onOpen={onOpen}
                onContextMenu={onContextMenu}
              />
            ) : (
              <NotificationRow
                key={entry.key}
                notification={entry.row}
                onOpen={onOpen}
                onContextMenu={onContextMenu}
              />
            )
          )
        )}
      </div>

      {entries.length > 0 && (
        <div className="px-5 py-3 border-t border-sol-border">
          <button
            onClick={onViewAll}
            className="text-sm text-sol-yellow hover:text-sol-yellow-bright transition-colors w-full text-center"
          >
            View all
          </button>
        </div>
      )}
    </div>
  );
}
