import { useInboxStore } from "../store/inboxStore";
import type { Device } from "../components/DeviceBadge";

export type ShareTeam = { _id: string; name: string; icon?: string | null; icon_color?: string | null };

/** The teams a machine is open to, as the viewer's team rows (unknown ids,
 *  a team since left, drop out). */
export function sharedTeamsOf(d: Pick<Device, "shared_team_ids">, teams: ShareTeam[]): ShareTeam[] {
  const ids = new Set(d.shared_team_ids ?? []);
  return teams.filter((t) => ids.has(String(t._id)));
}

export function useMyTeams(): ShareTeam[] {
  return (useInboxStore((s) => s.teams) ?? []) as ShareTeam[];
}

/** Team names as one phrase: "Acme", "Acme and Beta", "Acme, Beta and Core". */
export function listTeamNames(teams: ShareTeam[]): string {
  const names = teams.map((t) => t.name);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "shared with Acme" for a one-line row, or null when private. */
export function useSharedWithLabel(d: Device): string | null {
  const openTo = sharedTeamsOf(d, useMyTeams());
  return openTo.length ? `shared with ${listTeamNames(openTo)}` : null;
}
