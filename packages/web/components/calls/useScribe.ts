import { useCallback } from "react";
import { toast } from "sonner";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { SCRIBE_CLAIM_TTL_MS, scribeStatus, type ScribeStatus } from "@codecast/shared/contracts/scribePrompt";
import { SessionCreatePendingError, useInboxStore } from "../../store/inboxStore";
// The engine, not web's undoStack: that module installs sonner as the undo
// notifier when it loads, and the phone reaches this file (mobile bundleGraph guard).
import { withoutUndo } from "@platform/engine";
import type { ScribePress, ScribeRef } from "../../store/huddleSlice";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { inviteScribeFlow, type ScribeInviteDeps } from "../../lib/calls/scribeInvite";
import { characterForRoom, charactersInRoom, spawnSessionWithMessage } from "../../lib/calls/spawnFeedSession";

// The call's Scribe: the silent agent that keeps the board (convex
// transcriptsScribe.inviteScribe). One per call, held by the server: an invite
// claims the slot, and only the claimer spawns the agent and seats it.
//
// Whether Scribe is here is the live transcript's (getLive's scribe route and
// claim, which the caller already subscribes to). What carries a press across
// the round trip is the press itself, in flight: this window's ephemeral
// store state (huddleSlice scribePresses), from the click until the server
// has answered, so every surface of this window shows "joining" (or Scribe
// gone) in the frame it was pressed. Once the claim lands the transcript says "joining"
// for everyone in the call, through the agent's spawn and until it is seated.

/** The slice of transcripts.getLive this hook reads. */
export type ScribeLive = {
  transcript_id: string;
  team_id: string;
  short_id?: string | null;
  /** One person's own huddle (transcripts.getLive): Scribe works in their personal workspace. */
  personal?: boolean;
  routes: Array<{ kind: string; target: string; added_by: string; role?: string }>;
  scribe_claim?: { by: string; at: number; removed?: boolean } | null;
} | null | undefined;

const pressOf = (roomKey: string) => useInboxStore.getState().scribePresses[roomKey] ?? null;
const notePress = (roomKey: string, press: ScribePress | null) => useInboxStore.getState().noteScribePress(roomKey, press);

/** The Scribe a removal names: the one seated, else the one joining on its claim. */
export function scribeRefOf(live: ScribeLive): ScribeRef | null {
  const seated = live?.routes.find((r) => r.role === "scribe");
  if (seated) return { target: seated.target };
  return live?.scribe_claim && !live.scribe_claim.removed ? { claim: live.scribe_claim.at } : null;
}

/** What a surface shows: the server's status, unless this window's press is
 *  still on its way. An invite shows Scribe joining unless it is already in;
 *  a removal shows it gone. */
export function scribeShownStatus(server: ScribeStatus, press: ScribePress | null): ScribeStatus {
  if (press === "remove") return "absent";
  if (press === "invite" && server === "absent") return "joining";
  return server;
}

/** The flow's dependencies, bound to this app's store and Convex client. */
function scribeDeps(): ScribeInviteDeps {
  const st = () => useInboxStore.getState() as any;
  return {
    invite: (roomKey, auto) => (auto ? st().inviteScribe(roomKey, true) : st().inviteScribe(roomKey)),
    giveBack: (roomKey, claim) => st().removeScribe(roomKey, { give_back: claim }),
    spawn: spawnSessionWithMessage,
    seat: ({ transcript_id, ...route }) => st().addLiveRoute(transcript_id, route),
    character: (seed, routes) => characterForRoom(seed, charactersInRoom(routes)),
    // The feed names its own session; that is not the user's change.
    setCharacter: (id, c) => withoutUndo(() => st().setSessionCharacter(id, c)),
    landed: (stub) => st().getConvexId(stub),
    send: (id, text) => st().sendMessage(id, text),
    context: (roomKey, teamId) => ({
      occupants: (st().callOccupancy?.[roomKey] ?? []).length,
      workspaceName: (st().teams ?? []).find((t: any) => String(t?._id) === teamId)?.name,
    }),
  };
}

/** `onError` says a failed press the surface's own way (web: a toast; the phone: an alert). */
export function useScribe(roomKey: string | null, live: ScribeLive, onError: (title: string, message: string) => void = (_t, m) => toast.error(m)) {
  // A claim whose agent never landed stops holding the slot by the clock
  // alone: the one moment worth a re-render is that claim's expiry.
  const expiresAt = live?.scribe_claim ? live.scribe_claim.at + SCRIBE_CLAIM_TTL_MS : null;
  const now = useNowWhen((t) => (expiresAt === null ? "" : t < expiresAt ? "held" : "expired"), 15_000);
  const press = useInboxStore((s) => (roomKey ? (s.scribePresses[roomKey] ?? null) : null));
  const status = scribeShownStatus(scribeStatus(live, now), press);

  // `auto`: the person's "Invite Scribe to every huddle", not a press: the
  // server refuses it once somebody removed Scribe from this call.
  // Resolves whether this press seated Scribe.
  const invite = useCallback((opts?: { auto?: boolean }): Promise<boolean> => {
    if (!roomKey || !live || status !== "absent") return Promise.resolve(false);
    notePress(roomKey, "invite");
    return inviteScribeFlow(roomKey, live, scribeDeps(), { auto: opts?.auto, onClaimed: () => notePress(roomKey, null) })
      .then((r) => r === "claimed")
      .catch((err) => {
        onError(
          "Couldn't invite Scribe",
          err instanceof SessionCreatePendingError
            // The spawn waited the create out and told the session to stand down.
            ? "Scribe's session did not start in time, so Scribe did not join. Invite it again."
            : humanizeConvexError(err, "Could not invite Scribe"),
        );
        return false;
      })
      .finally(() => {
        if (pressOf(roomKey) === "invite") notePress(roomKey, null);
      });
  }, [roomKey, live, status, onError]);

  // Names the Scribe this window sees, so a replayed press never shows out
  // one invited since (transcriptsScribe.removeScribe).
  const remove = useCallback(() => {
    const which = scribeRefOf(live);
    if (!roomKey || status === "absent" || !which) return;
    notePress(roomKey, "remove");
    void useInboxStore
      .getState()
      .removeScribe(roomKey, which)
      .catch((err) => onError("Couldn't remove Scribe", humanizeConvexError(err, "Could not remove Scribe")))
      .finally(() => {
        if (pressOf(roomKey) === "remove") notePress(roomKey, null);
      });
  }, [roomKey, live, status, onError]);

  return { present: status !== "absent", status, invite, remove };
}
