// How a person's huddles start in each workspace: on the board, and with
// Scribe invited. Per person (the clientState.ui bag, so it follows them to
// every device) and per workspace (keyed by workspace key: "team:<id>", or
// "user:<id>" for the person's own huddles). Absent means off.
import { parseRoomKey } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import type { BannerMemo } from "../../store/huddleSlice";

/** The invite banner's words, on web and the phone. */
export const SCRIBE_INVITE_WORDS = "Scribe can diagram your huddles as you talk";

export type HuddleSettingKey = "huddleBoardView" | "huddleAutoScribe";

/** A huddle's workspace. One person's own huddle (a solo huddle, a private
 *  session's room: the server's `personal`, or a room of only `me` before the
 *  record loads) is their personal workspace, though it bills to a team it
 *  borrowed; any other huddle is its team's. Null until it can be told. */
export type HuddleWorkspace = { key: string; teamId: string | null; personal: boolean };

export function huddleWorkspace(
  roomKey: string | null | undefined,
  live: { team_id?: string | null; personal?: boolean } | null | undefined,
  me: string | null | undefined,
): HuddleWorkspace | null {
  if (!me) return null;
  const room = roomKey ? parseRoomKey(roomKey) : null;
  const mine = room?.kind === "dm" && room.users.length === 1 && room.users[0] === me;
  if (live?.personal || mine) return { key: `user:${me}`, teamId: null, personal: true };
  return live?.team_id ? { key: `team:${live.team_id}`, teamId: live.team_id, personal: false } : null;
}

/** What the person calls a huddle's workspace: Personal, or its team's name. */
export function huddleWorkspaceName(ws: HuddleWorkspace | null, teams: ReadonlyArray<{ _id?: unknown; name?: string }> | null | undefined): string {
  if (ws?.personal) return "Personal";
  return (teams ?? []).find((t) => String(t?._id) === ws?.teamId)?.name ?? "this workspace";
}

export function readHuddleSetting(ui: unknown, key: HuddleSettingKey, workspace: string | null): boolean {
  return !!workspace && (ui as { [k in HuddleSettingKey]?: Record<string, boolean> } | undefined)?.[key]?.[workspace] === true;
}

export function useHuddleSetting(key: HuddleSettingKey, workspace: string | null): boolean {
  return useInboxStore((s) => readHuddleSetting(s.clientState?.ui, key, workspace));
}

/** Write any of the settings for one workspace, leaving the other workspaces' as they are. */
export function setHuddleSettings(workspace: string, values: Partial<Record<HuddleSettingKey, boolean>>): void {
  const s = useInboxStore.getState();
  const ui = s.clientState.ui;
  const patch: { [k in HuddleSettingKey]?: Record<string, boolean> } = {};
  for (const [k, v] of Object.entries(values) as Array<[HuddleSettingKey, boolean]>) {
    if ((ui?.[k]?.[workspace] === true) !== v) patch[k] = { ...ui?.[k], [workspace]: v };
  }
  if (Object.keys(patch).length) s.updateClientUI(patch);
}

/** Whether the person has been shown the "Next time" banner in this workspace. */
export function useNextTimeSeen(workspace: string | null): boolean {
  return useInboxStore((s) => !!workspace && s.clientState?.ui?.huddleNextTimeSeen?.[workspace] === true);
}

/** Record that the "Next time" banner was shown in `workspace`: it never shows there again for this person. */
export function markNextTimeSeen(workspace: string): void {
  const s = useInboxStore.getState();
  const seen = s.clientState.ui?.huddleNextTimeSeen;
  if (seen?.[workspace]) return;
  s.updateClientUI({ huddleNextTimeSeen: { ...seen, [workspace]: true } });
}

/** Which banner shows over the board, if any. `memo`: what this person did
 *  with the banners in this call. `nextSeen`: the person was shown "Next
 *  time" in this workspace before; it stays up through the call that first
 *  showed it, and never shows again. */
export function boardBannerState(opts: { present: boolean; memo: BannerMemo; boardViewOn: boolean; autoScribeOn: boolean; nextSeen: boolean }): "invite" | "next" | null {
  const { present, memo } = opts;
  if (!present) return memo.dismissed ? null : "invite";
  if (memo.invited && !memo.nextClosed && (memo.nextShown || (!opts.nextSeen && !(opts.boardViewOn && opts.autoScribeOn)))) return "next";
  return null;
}

const EMPTY_MEMO: BannerMemo = {};

/** The board's banners, one rule for web and the phone: which shows, and what
 *  each press does. `callKey`: the live call's transcript id, so a new call
 *  starts fresh; the memo is this window's (store huddleBanners). */
export function useBoardBanner(callKey: string, workspace: string | null, scribe: { present: boolean; invite: () => Promise<boolean> }) {
  const memo = useInboxStore((s) => s.huddleBanners[callKey] ?? EMPTY_MEMO);
  const boardViewOn = useHuddleSetting("huddleBoardView", workspace);
  const autoScribeOn = useHuddleSetting("huddleAutoScribe", workspace);
  const nextSeen = useNextTimeSeen(workspace);
  const note = (patch: BannerMemo) => useInboxStore.getState().noteHuddleBanner(callKey, patch);
  return {
    state: boardBannerState({ present: scribe.present, memo, boardViewOn, autoScribeOn, nextSeen }),
    // "Next time" follows only an invite that seated Scribe.
    invite: () => void scribe.invite().then((ok) => ok && note({ invited: true })),
    dismiss: () => note({ dismissed: true }),
    /** "Next time" is on screen: shown once is shown for good in this
     *  workspace, and it stays up for the rest of this call until saved or closed. */
    shown: () => {
      if (useInboxStore.getState().huddleBanners[callKey]?.nextShown || !workspace) return;
      note({ nextShown: true });
      markNextTimeSeen(workspace);
    },
    close: () => note({ nextClosed: true }),
    /** Turning "Invite Scribe" on starts an agent in every huddle: that save goes through the review first. */
    needsReview: (autoScribe: boolean) => autoScribe && !autoScribeOn,
    save: (values: { boardView: boolean; autoScribe: boolean }) => {
      if (workspace) setHuddleSettings(workspace, { huddleBoardView: values.boardView, huddleAutoScribe: values.autoScribe });
      note({ nextClosed: true });
    },
  };
}
