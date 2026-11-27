// A huddle's board view, its Scribe and its live feeds: presses that carry a
// request to the server and resolve to its answer, each riding `dispatch` to
// the side effect of the same name (convex dispatch.ts). What a surface shows
// while the press is on its way is its own (useScribe's press; the live
// transcript is a query, not a store row), so the drafts paint nothing.
//
// Spread into the store (inboxStore), so it gains these without a line of its own.
import { asyncAction } from "./mutativeMiddleware";

export type HuddleSliceActions = {
  /** The call's board for this person's board view, made if the call has none, never pinned (callStage.openCallBoard). */
  openCallBoard: (roomKey: string) => Promise<{ doc_id: string } | undefined>;
  /** Ask for the call's Scribe (transcriptsScribe.inviteScribe); resolves to the claim answer, so the claimer spawns the agent.
   *  `auto`: the person's standing setting, refused once somebody removed Scribe from the call. */
  inviteScribe: (
    roomKey: string,
    auto?: boolean,
  ) => Promise<{ claimed: true; claim_id: number; transcript_id: string } | { claimed: false; existing: "joining" | "listening" | "removed" } | undefined>;
  /** Show the call's Scribe out (transcriptsScribe.removeScribe); with `claim`, only give back this client's failed claim. */
  removeScribe: (roomKey: string, claim?: number) => Promise<unknown>;
  /** Point a live call's words at a feed (transcripts.addRoute): a session, doc or Slack thread, or the Scribe seated in its claim. */
  addLiveRoute: (
    transcriptId: string,
    route: { kind: "session" | "doc" | "slack"; target: string; mode: "live" | "after"; face?: boolean; role?: "scribe"; claim?: number },
  ) => Promise<unknown>;
};

export function createHuddleSlice(): HuddleSliceActions {
  return {
    openCallBoard: asyncAction(function (this: any, roomKey: string) {
      return { roomKey };
    }) as unknown as HuddleSliceActions["openCallBoard"],
    inviteScribe: asyncAction(function (this: any, roomKey: string, auto?: boolean) {
      return { roomKey, auto };
    }) as unknown as HuddleSliceActions["inviteScribe"],
    removeScribe: asyncAction(function (this: any, roomKey: string, claim?: number) {
      return { roomKey, claim };
    }) as unknown as HuddleSliceActions["removeScribe"],
    addLiveRoute: asyncAction(function (this: any, transcriptId: string, route: { kind: string; target: string }) {
      return { transcriptId, route };
    }) as unknown as HuddleSliceActions["addLiveRoute"],
  };
}
