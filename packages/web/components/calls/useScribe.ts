import { useCallback, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { humanizeConvexError, SCRIBE_CLAIM_TTL_MS, scribeStatus, type ScribeStatus } from "@codecast/shared/contracts";
import { SessionCreatePendingError, useInboxStore } from "../../store/inboxStore";
import { withoutUndo } from "../../store/undoStack";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { inviteScribeFlow, type ScribeInviteDeps } from "../../lib/calls/scribeInvite";
import { characterForRoom, charactersInRoom, spawnSessionWithMessage } from "../../lib/calls/spawnFeedSession";

// The call's Scribe: the silent agent that keeps the board (convex
// transcripts.inviteScribe). One per call, held by the server: an invite
// claims the slot, and only the claimer spawns the agent and seats it.
//
// Whether Scribe is here is the live transcript's (getLive's scribe route and
// claim, which the caller already subscribes to). What carries a press across
// the round trip is the press itself, in flight, as a Record press does
// (lib/calls/recordingPress): from the click until the server has answered,
// so every surface of this window shows "joining" (or Scribe gone) in the
// frame it was pressed. Once the claim lands the transcript says "joining"
// for everyone in the call, through the agent's spawn and until it is seated.

/** The slice of transcripts.getLive this hook reads. */
export type ScribeLive = {
  transcript_id: string;
  team_id: string;
  short_id?: string | null;
  routes: Array<{ kind: string; target: string; added_by: string; role?: string }>;
  scribe_claim?: { by: string; at: number; removed?: boolean } | null;
} | null | undefined;

type Press = "invite" | "remove";
const presses = new Map<string, Press>();
const listeners = new Set<() => void>();
function notePress(roomKey: string, press: Press | null) {
  if (press) presses.set(roomKey, press);
  else presses.delete(roomKey);
  listeners.forEach((fn) => fn());
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** What a surface shows: the server's status, unless this window's press is
 *  still on its way. An invite shows Scribe joining unless it is already in;
 *  a removal shows it gone. */
export function scribeShownStatus(server: ScribeStatus, press: Press | null): ScribeStatus {
  if (press === "remove") return "absent";
  if (press === "invite" && server === "absent") return "joining";
  return server;
}

/** The flow's dependencies, bound to this app's store and Convex client. */
function scribeDeps(): ScribeInviteDeps {
  const st = () => useInboxStore.getState() as any;
  return {
    invite: (roomKey, auto) => (auto ? st().inviteScribe(roomKey, true) : st().inviteScribe(roomKey)),
    giveBack: (roomKey, claim) => st().removeScribe(roomKey, claim),
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
  const press = useSyncExternalStore(
    subscribe,
    () => (roomKey ? (presses.get(roomKey) ?? null) : null),
    () => null,
  );
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
        if (presses.get(roomKey) === "invite") notePress(roomKey, null);
      });
  }, [roomKey, live, status, onError]);

  const remove = useCallback(() => {
    if (!roomKey || status === "absent") return;
    notePress(roomKey, "remove");
    void useInboxStore
      .getState()
      .removeScribe(roomKey)
      .catch((err) => onError("Couldn't remove Scribe", humanizeConvexError(err, "Could not remove Scribe")))
      .finally(() => {
        if (presses.get(roomKey) === "remove") notePress(roomKey, null);
      });
  }, [roomKey, status, onError]);

  return { present: status !== "absent", status, invite, remove };
}
