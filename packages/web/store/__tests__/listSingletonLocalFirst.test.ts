import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// teams and currentUser are localFirst list/singleton keys: a store action's
// change holds over a stale push, the echo retires it, and a refusal puts the
// old value back, with no per-surface pending state.
const TEAM = "t".repeat(32);
const ME = "u".repeat(32);

describe("localFirst list and singleton writes", () => {
  const owner = {};
  let refuse = false;
  let calls: Array<{ action: string; args: any[] }> = [];
  beforeEach(() => {
    refuse = false;
    calls = [];
    useInboxStore.setState({
      teams: [{ _id: TEAM, name: "T", features: { chat: false } }],
      currentUser: { _id: ME, default_models: { claude: "opus" }, walkie_pref: "team" } as any,
      pending: {},
    } as any);
    useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
      calls.push({ action, args });
      if (refuse) throw new Error("Uncaught Error: no");
      return null;
    }, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it("a team feature flips now, survives a stale getUserTeams push, and dispatches", () => {
    useInboxStore.getState().setTeamFeature(TEAM, "chat", true);
    useInboxStore.getState().syncTable("teams", [{ _id: TEAM, name: "T2", features: { chat: false } }]);
    const team = (useInboxStore.getState().teams as any[])[0];
    expect(team.features.chat).toBe(true);
    expect(team.name).toBe("T2");
    expect(calls[0]).toEqual({ action: "setTeamFeature", args: [TEAM, "chat", true] });
    useInboxStore.getState().syncTable("teams", [{ _id: TEAM, name: "T2", features: { chat: true } }]);
    expect((useInboxStore.getState().pending as any)[`teams:${TEAM}:features`]).toBeUndefined();
  });

  it("a refused team feature goes back", async () => {
    refuse = true;
    useInboxStore.getState().setTeamFeature(TEAM, "chat", true);
    await settle(() => !(useInboxStore.getState().pending as any)[`teams:${TEAM}:features`]);
    expect((useInboxStore.getState().teams as any[])[0].features.chat).toBe(false);
  });

  it("a default model pin holds over a presence push and rolls back on refusal", async () => {
    useInboxStore.getState().setDefaultModel("claude", "sonnet");
    useInboxStore.getState().syncTable("currentUser", { _id: ME, default_models: { claude: "opus" }, walkie_pref: "team", last_seen: 5 });
    expect((useInboxStore.getState().currentUser as any).default_models.claude).toBe("sonnet");
    expect(calls[0]).toEqual({ action: "setDefaultModel", args: ["claude", "sonnet"] });

    refuse = true;
    useInboxStore.getState().setWalkiePref("off");
    expect((useInboxStore.getState().currentUser as any).walkie_pref).toBe("off");
    await settle(() => !(useInboxStore.getState().pending as any)["currentUser::walkie_pref"]);
    expect((useInboxStore.getState().currentUser as any).walkie_pref).toBe("team");
  });
});
