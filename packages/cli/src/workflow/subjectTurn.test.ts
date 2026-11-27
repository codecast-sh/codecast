import { describe, expect, test } from "bun:test";
import { PUSHED_QUIET_MS, SubjectTurn } from "./subjectTurn";

const MIN = 60_000;

function turn(heads: string[]) {
  let now = 1_000_000;
  const said: string[] = [];
  let reads = 0;
  const t = new SubjectTurn({
    cwd: "/repo", branch: "codecast/change-ct-1", shortId: "jx7abcd",
    say: (w) => { said.push(w); },
    now: () => now,
    readHead: async () => heads[Math.min(reads++, heads.length - 1)],
  });
  return { t, said, advance: (ms: number) => { now += ms; } };
}

describe("when the run's subject has answered its brief", () => {
  test("its agent's own status says the turn ended, whatever background work keeps its row working", () => {
    const { t } = turn(["a"]);
    expect(t.state({ work_state: "working", agent_status: "waiting" })).toBe("dormant");
    expect(t.state({ work_state: "working", agent_status: "idle" })).toBe("dormant");
    expect(t.state({ work_state: "working", agent_status: "working" })).toBe("working");
    expect(t.state({ work_state: "working" })).toBe("working");
    expect(t.state({ work_state: "done", agent_status: "done" })).toBe("done");
  });

  test("a session inside a turn is at work; one whose turn ended is not", async () => {
    const { t } = turn(["a"]);
    await t.begin();
    expect(await t.atWork({ work_state: "working", agent_status: "working", message_count: 20 }, false, 10)).toBe(true);
    expect(await t.atWork({ work_state: "working", agent_status: "waiting", message_count: 20 }, false, 10)).toBe(false);
    // Its transcript growing, or not yet past the brief and its reply, is work.
    expect(await t.atWork({ work_state: "working", agent_status: "waiting", message_count: 20 }, true, 10)).toBe(true);
    expect(await t.atWork({ work_state: "done", agent_status: "done", message_count: 11 }, false, 10)).toBe(true);
  });

  test("a push of the change's branch since the brief answers once the session is quiet the cap, and the words say it pushed", async () => {
    const { t, said, advance } = turn(["a", "a", "b"]);
    await t.begin();
    const stale = { work_state: "working", agent_status: "working", message_count: 30 };
    expect(await t.atWork(stale, false, 10)).toBe(true);
    advance(MIN);
    expect(await t.atWork(stale, false, 10)).toBe(true);
    expect(said).toEqual([]);
    advance(MIN);
    expect(await t.atWork(stale, false, 10)).toBe(true);
    expect(said).toEqual(["waiting for jx7abcd to finish; it pushed b just now"]);
    advance(5 * MIN);
    expect(await t.atWork(stale, false, 10)).toBe(true);
    expect(said.at(-1)).toBe("waiting for jx7abcd to finish; it pushed b 5 min ago");
    expect(t.state(stale)).toBe("working");
    advance(PUSHED_QUIET_MS);
    expect(await t.atWork(stale, false, 10)).toBe(false);
    expect(t.state(stale)).toBe("dormant");
  });

  test("a session still writing after its push is at work: the cap counts from its transcript's last move", async () => {
    const { t, advance } = turn(["a", "b"]);
    await t.begin();
    advance(MIN);
    expect(await t.atWork({ work_state: "working", agent_status: "working", message_count: 30 }, false, 10)).toBe(true);
    advance(PUSHED_QUIET_MS - MIN);
    expect(await t.atWork({ work_state: "working", agent_status: "working", message_count: 31 }, true, 10)).toBe(true);
    advance(PUSHED_QUIET_MS - MIN);
    expect(await t.atWork({ work_state: "working", agent_status: "working", message_count: 31 }, false, 10)).toBe(true);
    advance(2 * MIN);
    expect(await t.atWork({ work_state: "working", agent_status: "working", message_count: 31 }, false, 10)).toBe(false);
  });

  test("no branch to read, or one with no head at the brief, never answers by a push", async () => {
    let now = 0;
    const t = await new SubjectTurn({ cwd: "/repo", branch: null, shortId: "jx7abcd", say: () => {}, now: () => now, readHead: async () => "x" }).begin();
    now += PUSHED_QUIET_MS * 4;
    expect(await t.atWork({ work_state: "working", agent_status: "working", message_count: 30 }, false, 10)).toBe(true);
    const { t: u, advance } = turn(["", "b"]);
    await u.begin();
    advance(PUSHED_QUIET_MS * 4);
    expect(await u.atWork({ work_state: "working", agent_status: "working", message_count: 30 }, false, 10)).toBe(true);
  });
});
