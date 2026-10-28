"use client";

import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { confidenceFromSurfaces, kindMeta, type CapabilityDevice } from "./kinds";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { kitTeamLedger } from "../consequential/ledgers";
import { MachineDots } from "./MachineDots";
import type { FleetGridRow } from "./fleetRows";
import { kitKeyOf, setKitReach, useKitReach, type KitItem, type KitReach, type KitConflict, type KitWorkspace, type PendingConsent } from "./useKit";

export function KitList({
  title,
  items,
  rowFor,
  devices,
  ws,
  selectedKey,
  onOpen,
  searching,
  pending,
  conflicts,
}: {
  title: string;
  items: KitItem[];
  rowFor: (item: KitItem) => FleetGridRow | undefined;
  devices: CapabilityDevice[];
  ws: KitWorkspace;
  selectedKey: string | null;
  onOpen: (item: KitItem) => void;
  searching: boolean;
  pending: PendingConsent[];
  conflicts: KitConflict[];
}) {
  const slugs = useMemo(() => items.map((i) => i.slug), [items]);
  const reach = useKitReach(slugs);
  const members = useInboxStore((s) => s.teamMembers);
  const me = useInboxStore((s) => s.currentUser);
  const nameOf = (id?: string) => {
    if (!id) return undefined;
    if (me?._id && String(me._id) === id) return "you";
    const m = (members ?? []).find((u: any) => String(u?._id) === id);
    return m?.name?.split(" ")[0] ?? m?.github_username ?? undefined;
  };

  if (searching && items.length === 0) return null;

  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2 pb-2 border-b border-sol-border">
        <h2 className="text-sm font-medium text-sol-text">{title}</h2>
        <span className="text-xs text-sol-text-dim tabular-nums">{items.length || ""}</span>
      </div>
      {items.length === 0 ? (
        <p className="px-2 py-4 text-xs text-sol-text-dim">
          Nothing shared yet. Open a skill, command or subagent below and share it.
        </p>
      ) : (
        <ul>
          {items.map((item) => {
            const key = kitKeyOf(item.kind, item.name);
            const r = reach[item.slug] ?? { reach: "off" as KitReach, teamOn: false };
            const author = nameOf(item.author_user_id);
            return (
              <li
                key={item._id}
                className={`flex items-center gap-3 px-2 py-2 rounded-md transition-colors ${
                  selectedKey === key ? "bg-sol-bg-alt" : "hover:bg-sol-bg-alt"
                }`}
              >
                <button type="button" onClick={() => onOpen(item)} className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[13px] text-sol-text truncate">{item.name}</span>
                    <span className="text-[10px] text-sol-text-dim">{kindMeta(item.kind)?.label ?? item.kind}</span>
                    {(pending.some((p) => p.slug === item.slug) || conflicts.some((c) => c.slug === item.slug)) && (
                      <span className="text-[10px] text-sol-orange">needs you</span>
                    )}
                    {item.publishing ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-sol-text-dim">
                        <Loader2 className="h-3 w-3 animate-spin" /> uploading
                      </span>
                    ) : (
                      <span className="text-[10px] text-sol-text-dim tabular-nums">
                        v{item.current_version ?? 1}
                        {author ? ` · ${author}` : ""}
                      </span>
                    )}
                  </span>
                  {item.description && (
                    <span className="block text-xs text-sol-text-muted truncate">{item.description}</span>
                  )}
                </button>
                <MachineDots row={rowFor(item)} devices={devices} />
                <ReachControl
                  item={item}
                  value={r.reach}
                  teamOn={r.teamOn}
                  ws={ws}
                  disabled={!!item.publishing}
                  onChange={(next) => setKitReach(item, next, ws, r)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Who an item is on for. Everyone sees Off and Me; an admin of a team also
 * sees Team, which turns it on for every member's machines and so goes through
 * the confirm review. A member under a team-wide on still has Off, which holds
 * for their machines alone.
 */
export function ReachControl({
  item,
  value,
  teamOn,
  ws,
  disabled,
  onChange,
}: {
  item: KitItem;
  value: KitReach;
  teamOn: boolean;
  ws: KitWorkspace;
  disabled?: boolean;
  onChange: (next: KitReach) => void;
}) {
  const canTeam = ws.kind === "team" && ws.isAdmin;
  const members = useInboxStore((s) => (s.teamMembers ?? []).length);
  // A member whose team turned it on reads that as on, labelled Team.
  const shown: KitReach = !canTeam && value === "team" ? "me" : value;
  const ledger = kitTeamLedger({
    name: item.name,
    kit: ws.name,
    members,
    runsCode: confidenceFromSurfaces(item.surfaces as any) !== "prose",
  });
  const segment = (key: KitReach, label: string, press: () => void) => {
    const active = shown === key;
    return (
      <button
        key={key}
        type="button"
        role="radio"
        aria-checked={active}
        onClick={press}
        className={`h-6 px-2 rounded text-[11px] transition-colors ${
          active
            ? key === "off"
              ? "bg-sol-bg-alt text-sol-text"
              : "bg-sol-green text-sol-bg"
            : "text-sol-text-dim hover:text-sol-text"
        }`}
      >
        {label}
      </button>
    );
  };
  return (
    <ConsequentialSwitch
      on={value === "team"}
      ledger={ledger}
      onTurnOn={() => onChange("team")}
      onTurnOff={() => onChange("me")}
      trigger={(p) => (
        <div
          role="radiogroup"
          aria-label={`Who ${item.name} is on for`}
          className={`inline-flex shrink-0 rounded-md border border-sol-border p-0.5 ${disabled ? "opacity-50 pointer-events-none" : ""}`}
        >
          {segment("off", "Off", () => onChange("off"))}
          {segment("me", !canTeam && teamOn ? "Team" : "Me", () => onChange("me"))}
          {canTeam && segment("team", "Team", () => (value === "team" ? undefined : p.press()))}
        </div>
      )}
    />
  );
}
