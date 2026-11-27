// The call's Scribe from the phone: the same server path as web's useScribe
// (transcripts.inviteScribe claims the one slot, the claimer spawns the agent
// session and seats it with addRoute role "scribe", removeScribe ends it).
// Web's hook reaches the browser media room through useCallFeed, so the phone
// composes the same steps here, spawning through the shared
// lib/calls/spawnFeedSession.
import { useCallback, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { HUDDLE_FEED_DISREGARD, SCRIBE_CLAIM_TTL_MS, humanizeConvexError, scribeInstructions, scribeStatus, type ScribeStatus } from "@codecast/shared/contracts";
import { defaultCharacterFor } from "@codecast/shared/contracts/sessionCharacter";
import { SessionCreatePendingError, useInboxStore } from "@codecast/web/store/inboxStore";
import { withoutUndo } from "@codecast/web/store/undoStack";
import { spawnSessionWithMessage } from "@codecast/web/lib/calls/spawnFeedSession";
import { useNowWhen } from "@codecast/web/hooks/useCoarseNow";
import { appAlert } from "@/lib/popups";

/** The slice of transcripts.getLive Scribe reads. */
export type PhoneScribeLive = {
  transcript_id: string;
  team_id: string;
  short_id?: string | null;
  routes: Array<{ kind: string; target: string; role?: string }>;
  scribe_claim?: { by: string; at: number; removed?: boolean } | null;
} | null | undefined;

// A press in flight, by room, so the banner moves in the frame it is tapped.
type Press = "invite" | "remove";
const presses = new Map<string, Press>();
const listeners = new Set<() => void>();
function notePress(roomKey: string, press: Press | null) {
  if (press) presses.set(roomKey, press);
  else presses.delete(roomKey);
  listeners.forEach((fn) => fn());
}
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

function shown(server: ScribeStatus, press: Press | null): ScribeStatus {
  if (press === "remove") return "absent";
  if (press === "invite" && server === "absent") return "joining";
  return server;
}

export function usePhoneScribe(roomKey: string | null, live: PhoneScribeLive) {
  const convex = useConvex();
  const expiresAt = live?.scribe_claim ? live.scribe_claim.at + SCRIBE_CLAIM_TTL_MS : null;
  const now = useNowWhen((t) => (expiresAt === null ? "" : t < expiresAt ? "held" : "expired"), 15_000);
  const press = useSyncExternalStore(subscribe, () => (roomKey ? (presses.get(roomKey) ?? null) : null), () => null);
  const status = shown(scribeStatus(live, now), press);

  const invite = useCallback(() => {
    if (!roomKey || !live || status !== "absent") return;
    notePress(roomKey, "invite");
    void (async () => {
      let claim: number | null = null;
      let session: string | null = null;
      try {
        const answer = await convex.mutation(api.transcripts.inviteScribe, { room_key: roomKey });
        if (!answer.claimed) return;
        claim = answer.claim_id;
        const st = useInboxStore.getState() as any;
        const team = (st.teams ?? []).find((t: any) => String(t?._id) === live.team_id);
        const instructions = scribeInstructions({
          solo: (st.callOccupancy?.[roomKey] ?? []).length <= 1,
          callShortId: live.short_id ?? undefined,
          workspaceName: team?.name,
        });
        notePress(roomKey, null);
        let stub: string | null = null;
        try {
          session = await spawnSessionWithMessage(
            (stubId) => {
              stub = stubId;
              return instructions;
            },
            (id) => {
              const c = defaultCharacterFor(stub ?? id);
              withoutUndo(() => st.setSessionCharacter(id, { avatar: c.avatar, name: "Scribe" }));
            },
            live.team_id,
            false,
          );
        } catch (err) {
          const landed = stub ? st.getConvexId(stub) : undefined;
          if (landed) st.sendMessage(landed, HUDDLE_FEED_DISREGARD);
          throw err;
        }
        await convex.mutation(api.transcripts.addRoute, {
          transcript_id: live.transcript_id as any,
          kind: "session",
          target: session,
          mode: "live",
          face: false,
          role: "scribe",
          claim,
        });
      } catch (err) {
        // The session must not wait for words that will never come, and the
        // slot goes back at once rather than when the claim expires.
        if (session) (useInboxStore.getState() as any).sendMessage(session, HUDDLE_FEED_DISREGARD);
        if (claim !== null) void convex.mutation(api.transcripts.removeScribe, { room_key: roomKey, claim }).catch(() => {});
        appAlert(
          "Couldn't invite Scribe",
          err instanceof SessionCreatePendingError
            ? "Scribe's session did not start in time, so Scribe did not join. Invite it again."
            : humanizeConvexError(err, "Could not invite Scribe"),
        );
      } finally {
        if (presses.get(roomKey) === "invite") notePress(roomKey, null);
      }
    })();
  }, [convex, roomKey, live, status]);

  const remove = useCallback(() => {
    if (!roomKey || status === "absent") return;
    notePress(roomKey, "remove");
    void convex
      .mutation(api.transcripts.removeScribe, { room_key: roomKey })
      .catch((err) => appAlert("Couldn't remove Scribe", humanizeConvexError(err, "Could not remove Scribe")))
      .finally(() => {
        if (presses.get(roomKey) === "remove") notePress(roomKey, null);
      });
  }, [convex, roomKey, status]);

  return { present: status !== "absent", status, invite, remove };
}
