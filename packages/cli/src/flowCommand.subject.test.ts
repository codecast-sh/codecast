// `cast flow run change --task ct-N --branch <b>` from inside a session (ct-85594):
// the session that started the run is its subject, so a failed stage reaches it
// instead of failing with "This run's change came from no session". From a plain
// shell, the session that owns the task is.
import { describe, expect, test } from "bun:test";
import { callingSubject } from "./flowCommand";
import { changeReturnWords } from "./workflow/flowChangeFile";

const FULL = "jx756fbmcg1nk6fckmvf4xvhsh8hj4bw";

describe("callingSubject", () => {
  test("the calling session, named by its agent session id, resolves to its conversation", async () => {
    const asked: any[] = [];
    const subject = await callingSubject({
      callingSession: () => "0b6f1c2e-agent-session",
      cliPost: async (route, body) => { asked.push({ route, body }); return { sessions: [{ id: FULL }] }; },
    });
    expect(subject).toEqual({ session: "jx756fb", conversation: FULL });
    expect(asked[0]).toMatchObject({ route: "/cli/inbox", body: { session_ids: ["0b6f1c2e-agent-session"] } });
  });

  test("a plain shell has none", async () => {
    expect(await callingSubject({ callingSession: () => undefined, cliPost: async () => { throw new Error("not asked"); } })).toBeUndefined();
  });

  test("a plain shell running a task's change takes the session the task's change came from (a run started over ssh)", async () => {
    const asked: any[] = [];
    const subject = await callingSubject({
      callingSession: () => undefined,
      cliPost: async (route, body) => { asked.push({ route, body }); return { short_id: "ct-9", change_session: { short_id: "jx756fb", conversation_id: FULL } }; },
    }, "ct-9");
    expect(subject).toEqual({ session: "jx756fb", conversation: FULL });
    expect(asked).toEqual([{ route: "/cli/work/get", body: { short_id: "ct-9" } }]);
  });

  test("a task no session worked leaves a plain shell with none", async () => {
    expect(await callingSubject({ callingSession: () => undefined, cliPost: async () => ({ short_id: "ct-9", change_session: null }) }, "ct-9")).toBeUndefined();
  });

  test("a session the server cannot read has none", async () => {
    expect(await callingSubject({ callingSession: () => "x", cliPost: async () => ({ sessions: [] }) })).toBeUndefined();
  });
});

describe("changeReturnWords", () => {
  test("each kind of change says how the run takes the fix back", () => {
    expect(changeReturnWords({ source: "session" })).toBe("When you end your turn the run freezes this session's edits again");
    expect(changeReturnWords({ source: "branch", branch: "feat" })).toBe("Commit the fix to branch feat and push it; when you end your turn the run reads that branch again");
    expect(changeReturnWords({ source: "pr", branch: "feat" })).toContain("Push the fix to the pull request's branch feat");
  });
});
