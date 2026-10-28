"use client";

// The kit: what this workspace shares (docs/architecture/team-kit.md). Rows come
// from the `teamKitItems` collection; who has each one on comes from bindings,
// the same rows the daemon's resolver folds.

import { useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useWorkspaceCollection, useActiveWorkspaceKey } from "../../hooks/useWorkspaceCollection";

/** The join between a kit item and what machines report: kind plus name. */
export function kitKeyOf(kind: string, name: string): string {
  return `${kind}|${name.toLowerCase()}`;
}

export type KitItem = {
  _id: string;
  slug: string;
  kind: string;
  name: string;
  description?: string;
  author_user_id?: string;
  current_version?: number;
  current_hash?: string;
  team_id?: string;
  workspace?: string;
  updated_at?: number;
  /** The current version's execution surfaces, derived server side. */
  surfaces?: string[];
  /** A share asked for from the web, waiting for its machine to upload. */
  publishing?: boolean;
  removed_at?: number;
};

/** Who an item is on for: off, the viewer's own machines, or the whole team. */
export type KitReach = "off" | "me" | "team";

export interface KitWorkspace {
  key: string | null;
  kind: "team" | "user" | null;
  teamId?: string;
  /** The id a kit slug is owned under: the team's, or the person's own. */
  ownerId?: string;
  name: string;
  isAdmin: boolean;
}

/** The kit of one workspace: the active one, or `override` (the person's own kit beside a team's). */
export function useKitWorkspace(override?: string | null): KitWorkspace {
  const active = useActiveWorkspaceKey();
  const key = override ?? active;
  const teams = useInboxStore((s) => s.teams);
  return useMemo(() => {
    if (!key) return { key: null, kind: null, name: "Your kit", isAdmin: false };
    if (key.startsWith("team:")) {
      const teamId = key.slice("team:".length);
      const team = (teams ?? []).find((t: any) => String(t?._id) === teamId);
      return {
        key,
        kind: "team",
        teamId,
        ownerId: teamId,
        name: team?.name ? `${team.name} kit` : "Team kit",
        isAdmin: team?.role === "admin" || team?.role === "owner",
      };
    }
    return { key, kind: "user", ownerId: key.slice("user:".length), name: "Your kit", isAdmin: true };
  }, [key, teams]);
}

const kitSig = (r: KitItem) =>
  `${r.updated_at ?? 0}|${r.current_version ?? 0}|${r.publishing ? 1 : 0}|${r.removed_at ?? 0}`;

export function useKitItems(workspace?: string | null): KitItem[] {
  const rows = useWorkspaceCollection("teamKitItems", kitSig, workspace) as unknown as KitItem[];
  return useMemo(
    () => rows.filter((r) => !r.removed_at).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    [rows],
  );
}

/** Each kit slug's reach for the viewer, from the binding rows. */
export function useKitReach(slugs: string[]): Record<string, { reach: KitReach; teamOn: boolean }> {
  const bindings = useInboxStore((s) => s.capabilityBindings);
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  return useMemo(() => {
    const out: Record<string, { reach: KitReach; teamOn: boolean }> = {};
    const want = new Set(slugs);
    const rows = Object.values(bindings ?? {}).filter((b) => want.has(b.capability_slug));
    for (const slug of slugs) {
      const mine = rows.find(
        (b) => b.capability_slug === slug && b.scope_kind === "user" && (!b.user_id || String(b.user_id) === meId),
      );
      const team = rows.find((b) => b.capability_slug === slug && b.scope_kind === "team");
      const teamOn = !!team?.enabled;
      // A person's own row wins over the team's: the resolver ranks user scope
      // narrower than team, so "off for me" holds under a team-wide on.
      const onForMe = mine ? mine.enabled : teamOn;
      out[slug] = { reach: !onForMe ? "off" : teamOn ? "team" : "me", teamOn };
    }
    return out;
  }, [bindings, slugs, meId]);
}

/** Set an item's reach. Admins move the team row; everyone moves their own. */
export function setKitReach(
  item: KitItem,
  reach: KitReach,
  ws: KitWorkspace,
  current: { teamOn: boolean },
): void {
  const set = useInboxStore.getState().setCapabilityBinding;
  const teamWide = ws.kind === "team" && ws.isAdmin;
  if (teamWide && reach === "team") {
    set({ capability_slug: item.slug, scope_kind: "team", scope_key: "", enabled: true, team_id: ws.teamId });
    set({ capability_slug: item.slug, scope_kind: "user", scope_key: "", enabled: true });
    return;
  }
  if (teamWide && current.teamOn) {
    set({ capability_slug: item.slug, scope_kind: "team", scope_key: "", enabled: false, team_id: ws.teamId });
  }
  set({ capability_slug: item.slug, scope_kind: "user", scope_key: "", enabled: reach !== "off" });
}

/** Machines waiting for a person's OK before a kit version that runs code installs. */
export type PendingConsent = { device_id: string; slug: string; hash: string };

/** A machine where the kit's copy collides with a file a person made by hand. */
export type KitConflict = { device_id: string; slug: string; hash: string; detail?: string };
