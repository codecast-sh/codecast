// Inviting the call's Scribe, one flow for web and the phone (pl-1145). The
// server holds one slot per call (transcripts.inviteScribe): the client whose
// invite claims it spawns the agent session, briefed with the Scribe prompt
// and working out of sight, then seats it on the live transcript as the
// "scribe" route, with no face. A failure past the claim gives the slot back
// at once (rather than hold it until the claim expires) and tells a spawned
// session that no words are coming. No React here: the surfaces bring the
// press state and say the error their own way.
import { HUDDLE_FEED_DISREGARD, scribeInstructions } from "@codecast/shared/contracts";
import type { Character } from "@codecast/shared/contracts/sessionCharacter";

/** The slice of transcripts.getLive the invite reads. */
export type ScribeInviteLive = {
  transcript_id: string;
  team_id: string;
  short_id?: string | null;
  routes: Array<{ kind: string; target: string }>;
};

export type ScribeInviteDeps = {
  /** store.inviteScribe */
  invite: (roomKey: string, auto?: boolean) => Promise<{ claimed: true; claim_id: number } | { claimed: false } | undefined>;
  /** store.removeScribe with the claim: gives back only this client's claim. */
  giveBack: (roomKey: string, claim: number) => Promise<unknown>;
  /** spawnSessionWithMessage */
  spawn: (body: (stubId: string) => string, onReady: (convexId: string) => void, teamId: string | null, openPanel: boolean) => Promise<string>;
  /** transcripts.addRoute */
  seat: (args: { transcript_id: string; kind: "session"; target: string; mode: "live"; face: false; role: "scribe"; claim: number }) => Promise<unknown>;
  /** characterForRoom(seed, charactersInRoom(routes)) */
  character: (seed: string, routes: ScribeInviteLive["routes"]) => Character;
  setCharacter: (convexId: string, c: { avatar: string; name: string }) => void;
  /** The real id a stub landed as, if it has. */
  landed: (stubId: string) => string | undefined;
  send: (convexId: string, text: string) => void;
  /** Who else is in the room now (solo or group briefing) and the workspace's name. */
  context: (roomKey: string, teamId: string) => { occupants: number; workspaceName?: string };
};

/**
 * Invite Scribe. Resolves "claimed" once Scribe is seated, "taken" when the
 * slot was not ours (somebody else's Scribe is joining or in, or an automatic
 * invite met a removal). Throws when a claimed invite failed, after giving
 * the claim back. `onClaimed` runs the moment the slot is ours.
 */
export async function inviteScribeFlow(
  roomKey: string,
  live: ScribeInviteLive,
  deps: ScribeInviteDeps,
  opts: { auto?: boolean; onClaimed?: () => void } = {},
): Promise<"claimed" | "taken"> {
  const answer = opts.auto ? await deps.invite(roomKey, true) : await deps.invite(roomKey);
  if (!answer?.claimed) return "taken";
  const claim = answer.claim_id;
  opts.onClaimed?.();
  let stub: string | null = null;
  let session: string | null = null;
  try {
    const ctx = deps.context(roomKey, live.team_id);
    const instructions = scribeInstructions({
      solo: ctx.occupants <= 1,
      callShortId: live.short_id ?? undefined,
      workspaceName: ctx.workspaceName,
    });
    let character: Character | null = null;
    session = await deps.spawn(
      (stubId) => {
        stub = stubId;
        character = { ...deps.character(stubId, live.routes), name: "Scribe" };
        return instructions;
      },
      (id) => {
        if (character) deps.setCharacter(id, { avatar: character.avatar, name: character.name });
      },
      live.team_id,
      false,
    );
    await deps.seat({ transcript_id: live.transcript_id, kind: "session", target: session, mode: "live", face: false, role: "scribe", claim });
    return "claimed";
  } catch (err) {
    // The spawn may have given up while the create was parked and landed since.
    const orphan = session ?? (stub ? deps.landed(stub) : undefined);
    if (orphan) deps.send(orphan, HUDDLE_FEED_DISREGARD);
    void deps.giveBack(roomKey, claim).catch(() => {});
    throw err;
  }
}
