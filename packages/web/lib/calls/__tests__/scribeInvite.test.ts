import { describe, expect, mock, test } from "bun:test";
import { HUDDLE_FEED_DISREGARD } from "@codecast/shared/contracts";
import { inviteScribeFlow, type ScribeInviteDeps, type ScribeInviteLive } from "../scribeInvite";

const live: ScribeInviteLive = { transcript_id: "t1", team_id: "team1", short_id: "cl-7", routes: [{ kind: "session", target: "s-other" }] };

function deps(over: Partial<ScribeInviteDeps> = {}) {
  const d = {
    invite: mock(async () => ({ claimed: true as const, claim_id: 42 })),
    giveBack: mock(async () => ({})),
    spawn: mock(async (body: (stub: string) => string, onReady: (id: string) => void) => {
      body("stub-1");
      onReady("conv-1");
      return "conv-1";
    }),
    seat: mock(async () => ({})),
    character: mock(() => ({ avatar: "fox", name: "Ember", chosen: true })),
    setCharacter: mock(() => {}),
    landed: mock(() => undefined as string | undefined),
    send: mock(() => {}),
    context: mock(() => ({ occupants: 2, workspaceName: "Codecast" })),
    ...over,
  };
  return d as typeof d & ScribeInviteDeps;
}

describe("inviteScribeFlow", () => {
  test("a claimed invite spawns Scribe out of sight and seats it with no face, as the scribe, in its claim", async () => {
    const d = deps();
    const onClaimed = mock(() => {});
    expect(await inviteScribeFlow("channel:a", live, d, { onClaimed })).toBe("claimed");
    expect(onClaimed).toHaveBeenCalledTimes(1);
    expect(d.seat).toHaveBeenCalledWith({ transcript_id: "t1", kind: "session", target: "conv-1", mode: "live", face: false, role: "scribe", claim: 42 });
    // Spawned for the room's team, without opening a panel.
    expect(d.spawn.mock.calls[0][2]).toBe("team1");
    expect(d.spawn.mock.calls[0][3]).toBe(false);
    // The room's face, named Scribe.
    expect(d.character).toHaveBeenCalledWith("stub-1", live.routes);
    expect(d.setCharacter).toHaveBeenCalledWith("conv-1", { avatar: "fox", name: "Scribe" });
    expect(d.giveBack).not.toHaveBeenCalled();
  });

  test("auto asks as an automatic invite", async () => {
    const d = deps();
    await inviteScribeFlow("channel:a", live, d, { auto: true });
    expect(d.invite).toHaveBeenCalledWith("channel:a", true);
  });

  test("a slot somebody else holds spawns nothing", async () => {
    const d = deps({ invite: mock(async () => ({ claimed: false as const })) });
    expect(await inviteScribeFlow("channel:a", live, d)).toBe("taken");
    expect(d.spawn).not.toHaveBeenCalled();
    expect(d.seat).not.toHaveBeenCalled();
  });

  test("a failed spawn gives the claim back and stands down a session that landed late", async () => {
    const d = deps({
      spawn: mock(async (body: (stub: string) => string) => {
        body("stub-9");
        throw new Error("spawn timed out");
      }),
      landed: mock((stub: string) => (stub === "stub-9" ? "conv-late" : undefined)),
    });
    await expect(inviteScribeFlow("channel:a", live, d)).rejects.toThrow("spawn timed out");
    expect(d.giveBack).toHaveBeenCalledWith("channel:a", 42);
    expect(d.send).toHaveBeenCalledWith("conv-late", HUDDLE_FEED_DISREGARD);
    expect(d.seat).not.toHaveBeenCalled();
  });

  test("a failed seat gives the claim back and tells the spawned session no words are coming", async () => {
    const d = deps({ seat: mock(async () => { throw new Error("The call has ended"); }) });
    await expect(inviteScribeFlow("channel:a", live, d)).rejects.toThrow("The call has ended");
    expect(d.giveBack).toHaveBeenCalledWith("channel:a", 42);
    expect(d.send).toHaveBeenCalledWith("conv-1", HUDDLE_FEED_DISREGARD);
  });
});
