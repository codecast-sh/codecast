// Whether the phone offers a huddle. `callConfig` (calls.getCallConfig) lists
// the viewer's teams that have calls on, and is disabled outright when the
// deployment has no LiveKit. A team reads its own opt-in. Personal, and a room
// with no team of the viewer's behind it, borrow a billing team on the server
// (callRooms' sharedTeam / session borrow), so they are on when any of the
// viewer's teams has calls on.

import { dmRoomKey } from "@codecast/shared/contracts";

export type CallConfig = { enabled: boolean; teams?: string[] } | null | undefined;

/** Calls in the active workspace (unset = Personal). */
export function callsOnInWorkspace(config: CallConfig, activeTeamId: string | null | undefined): boolean {
  if (config?.enabled !== true) return false;
  const teams = config.teams ?? [];
  return activeTeamId ? teams.includes(String(activeTeamId)) : teams.length > 0;
}

/** Calls for a room anchored in `roomTeamId` (a session's or channel's team).
 *  A team the viewer is on decides for itself; no team, or a team the viewer
 *  has left, borrows. */
export function callsOnForRoom(config: CallConfig, roomTeamId: string | null | undefined, myTeamIds: readonly string[]): boolean {
  if (config?.enabled !== true) return false;
  const teams = config.teams ?? [];
  if (roomTeamId && myTeamIds.includes(String(roomTeamId))) return teams.includes(String(roomTeamId));
  return teams.length > 0;
}

/** A huddle with people: their room (the same key web's chips use) and who
 *  to ring. Picking only yourself is your room of one, ringing nobody. */
export function peopleHuddle(viewerId: string, userIds: readonly string[]): { roomKey: string; toUserIds: string[] } {
  return { roomKey: dmRoomKey(viewerId, [...userIds]), toUserIds: userIds.filter((id) => id !== viewerId) };
}
