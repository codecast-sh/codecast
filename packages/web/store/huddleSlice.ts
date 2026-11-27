// A huddle's board view, its Scribe and its live feeds: presses that carry a
// request to the server and resolve to its answer, each riding `dispatch` to
// the side effect of the same name (convex dispatch.ts). The drafts paint
// nothing: the live transcript is a query, not a store row. What a surface
// shows while a press is on its way is this window's own ephemeral state
// below (raw set: a gesture, never persisted or synced).
//
// Spread into the store (inboxStore), so it gains these without a line of its own.
import { asyncAction } from "./mutativeMiddleware";

/** How a person's huddles start, per workspace key (clientState.ui, lib/calls/huddleSettings). */
export type HuddleClientUI = {
  // On the board, and with Scribe invited.
  huddleBoardView?: Record<string, boolean>;
  huddleAutoScribe?: Record<string, boolean>;
  // The workspaces where the person has been shown the board's "Next time"
  // banner: it shows once per person per workspace, ever.
  huddleNextTimeSeen?: Record<string, true>;
};

/** A Scribe press on its way, by room key (useScribe). */
export type ScribePress = "invite" | "remove";

/** What one person did with the board's banners in one call (lib/calls/huddleSettings boardBannerState). */
export type BannerMemo = { dismissed?: true; invited?: true; nextShown?: true; nextClosed?: true };

/** Which Scribe a removal names: seated (its route's target) or joining (its claim's `at`);
 *  `give_back`: the inviter handing back its own claim whose agent failed to start. */
export type ScribeRef = { target: string } | { claim: number } | { give_back: number };

export type HuddleSliceState = {
  scribePresses: Record<string, ScribePress>;
  /** By call key (room|transcript): held across switching views and back, gone with the window. */
  huddleBanners: Record<string, BannerMemo>;
};

export type HuddleSliceActions = HuddleSliceState & {
  /** The call's board for this person's board view, made if the call has none, never pinned (callStage.openCallBoard). */
  openCallBoard: (roomKey: string) => Promise<{ doc_id: string } | undefined>;
  /** Ask for the call's Scribe (transcriptsScribe.inviteScribe); resolves to the claim answer, so the claimer spawns the agent.
   *  `auto`: the person's standing setting, refused once somebody removed Scribe from the call. */
  inviteScribe: (
    roomKey: string,
    auto?: boolean,
  ) => Promise<{ claimed: true; claim_id: number; transcript_id: string } | { claimed: false; existing: "joining" | "listening" | "removed" } | undefined>;
  /** Show the call's Scribe out, the one this window saw (transcriptsScribe.removeScribe), or give back a failed claim. */
  removeScribe: (roomKey: string, which: ScribeRef) => Promise<unknown>;
  /** Point a live call's words at a feed (transcripts.addRoute): a session, doc or Slack thread, or the Scribe seated in its claim. */
  addLiveRoute: (
    transcriptId: string,
    route: { kind: "session" | "doc" | "slack"; target: string; mode: "live" | "after"; face?: boolean; role?: "scribe"; claim?: number },
  ) => Promise<unknown>;
  /** Mark or clear this window's Scribe press for a room. */
  noteScribePress: (roomKey: string, press: ScribePress | null) => void;
  noteHuddleBanner: (callKey: string, patch: BannerMemo) => void;
};

export function createHuddleSlice(set: any, get: () => HuddleSliceState): HuddleSliceActions {
  return {
    scribePresses: {},
    huddleBanners: {},
    noteScribePress: (roomKey, press) => {
      const { [roomKey]: _gone, ...rest } = get().scribePresses;
      set({ scribePresses: press ? { ...rest, [roomKey]: press } : rest });
    },
    noteHuddleBanner: (callKey, patch) => {
      const banners = get().huddleBanners;
      set({ huddleBanners: { ...banners, [callKey]: { ...banners[callKey], ...patch } } });
    },
    openCallBoard: asyncAction(function (this: any, roomKey: string) {
      return { roomKey };
    }) as unknown as HuddleSliceActions["openCallBoard"],
    inviteScribe: asyncAction(function (this: any, roomKey: string, auto?: boolean) {
      return { roomKey, auto };
    }) as unknown as HuddleSliceActions["inviteScribe"],
    removeScribe: asyncAction(function (this: any, roomKey: string, which: ScribeRef) {
      return { roomKey, which };
    }) as unknown as HuddleSliceActions["removeScribe"],
    addLiveRoute: asyncAction(function (this: any, transcriptId: string, route: { kind: string; target: string }) {
      return { transcriptId, route };
    }) as unknown as HuddleSliceActions["addLiveRoute"],
  };
}
