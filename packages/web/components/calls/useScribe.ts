import { useCallback, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { humanizeConvexError, SCRIBE_CLAIM_TTL_MS, scribeInstructions, scribeStatus, type ScribeStatus } from "@codecast/shared/contracts";
import { SessionCreatePendingError, useInboxStore } from "../../store/inboxStore";
import { getRoom } from "../../lib/calls/callManager";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { useAddLiveFeed } from "./useCallFeed";

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

export function useScribe(roomKey: string | null, live: ScribeLive) {
  const convex = useConvex();
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
  const addFeed = useAddLiveFeed({
    roomKey,
    liveTranscriptId: live?.transcript_id ?? null,
    routes: live?.routes,
    teamId: live?.team_id,
    getRoom,
  });

  // `auto`: the person's "Invite Scribe to every huddle", not a press: the
  // server refuses it once somebody removed Scribe from this call.
  const invite = useCallback((opts?: { auto?: boolean }) => {
    if (!roomKey || status !== "absent") return;
    notePress(roomKey, "invite");
    void (async () => {
      let claim: number | null = null;
      try {
        const answer = await convex.mutation(api.transcripts.inviteScribe, { room_key: roomKey, ...(opts?.auto ? { auto: true } : {}) });
        // Somebody else's Scribe is joining or in (the transcript shows it),
        // or an automatic invite met a removal.
        if (!answer.claimed) return;
        claim = answer.claim_id;
        const st = useInboxStore.getState() as any;
        const team = (st.teams ?? []).find((t: any) => String(t?._id) === live?.team_id);
        const instructions = scribeInstructions({
          solo: (st.callOccupancy?.[roomKey] ?? []).length <= 1,
          callShortId: live?.short_id ?? undefined,
          workspaceName: team?.name,
        });
        notePress(roomKey, null);
        await addFeed({ kind: "new-session" }, { face: false, scribe: { claim: answer.claim_id, instructions } });
      } catch (err) {
        // Give the slot back at once rather than hold it until the claim
        // expires; a Scribe somebody else has invited since stays.
        if (claim !== null) void convex.mutation(api.transcripts.removeScribe, { room_key: roomKey, claim }).catch(() => {});
        toast.error(
          err instanceof SessionCreatePendingError
            // addFeed waited the spawn out and told the session to stand down.
            ? "Scribe's session did not start in time, so Scribe did not join. Invite it again."
            : humanizeConvexError(err, "Could not invite Scribe"),
        );
      } finally {
        if (presses.get(roomKey) === "invite") notePress(roomKey, null);
      }
    })();
  }, [convex, roomKey, status, live?.team_id, live?.short_id, addFeed]);

  const remove = useCallback(() => {
    if (!roomKey || status === "absent") return;
    notePress(roomKey, "remove");
    void convex
      .mutation(api.transcripts.removeScribe, { room_key: roomKey })
      .catch((err) => toast.error(humanizeConvexError(err, "Could not remove Scribe")))
      .finally(() => {
        if (presses.get(roomKey) === "remove") notePress(roomKey, null);
      });
  }, [convex, roomKey, status]);

  return { present: status !== "absent", status, invite, remove };
}
