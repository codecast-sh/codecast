import { describe, expect, test } from "bun:test";
import { PUSHED_QUIET_MS, SubjectTurn } from "./subjectTurn";

const MIN = 60_000;

/** A turn whose branch reads each of `heads` in turn (the last one after), on a clock the test moves. */
function turn(heads: Array<string | null | undefined>) {
  let now = 1_000_000;
  const said: string[] = [];
  let reads = 0;
  const t = new SubjectTurn({
    cwd: "/repo", branch: "codecast/change-ct-1", shortId: "jx7abcd",
    say: (w) => { said.push(w); },
    now: () => now,
    readHead: async () => heads[Math.min(reads++, heads.length - 1)],
  });
  // A row as fresh as the clock, so its status is trusted.
  const row = (agent_status: string | null, message_count = 30, work_state = "working") => ({ work_state, agent_status, message_count, ts: now });
  return { t, said, row, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe("when the run's subject has answered its brief", () => {
  test("idle, done and dormant end the turn, whatever background work keeps its row working; inside a turn never does", async () => {
    const { t, row } = turn(["a"]);
    await t.begin();
    for (const s of ["idle", "done", "dormant"]) {
      expect(t.state(row(s))).toBe("dormant");
      expect(await t.atWork(row(s), false, 10)).toBe(false);
    }
    for (const s of ["working", "thinking", "compacting"]) {
      expect(t.state(row(s))).toBe("working");
      expect(await t.atWork(row(s), false, 10)).toBe(true);
    }
    expect(t.state(row(null))).toBe("working");
    expect(await t.atWork(row(null), false, 10)).toBe(true);
    // Its transcript growing, or not yet past the brief and its reply, is work.
    expect(await t.atWork(row("idle"), true, 10)).toBe(true);
    expect(await t.atWork(row("done", 11, "done"), false, 10)).toBe(true);
  });

  test("waiting on background work it started, with no push, is still the brief's work: the run waits", async () => {
    const { t, row, advance } = turn(["a"]);
    await t.begin();
    for (let i = 0; i < 40; i++) {
      advance(MIN);
      expect(await t.atWork(row("waiting"), false, 10)).toBe(true);
      expect(t.state(row("waiting"))).toBe("working");
    }
  });

  // ct-102698: its subject pushed the fix, ended its turn on waiting (agents still running) and went quiet.
  test("waiting after a push of the change's branch since the brief ends once the session is quiet the window; the words say it pushed", async () => {
    const { t, said, row, advance } = turn(["a", "a", "b"]);
    await t.begin();
    expect(await t.atWork(row("waiting"), false, 10)).toBe(true);
    advance(MIN);
    expect(await t.atWork(row("waiting"), false, 10)).toBe(true);
    expect(said).toEqual([]);
    advance(MIN);
    expect(await t.atWork(row("waiting"), false, 10)).toBe(true);
    expect(said).toEqual(["waiting for jx7abcd to finish; it pushed b just now"]);
    advance(5 * MIN);
    expect(await t.atWork(row("waiting"), false, 10)).toBe(true);
    expect(said.at(-1)).toBe("waiting for jx7abcd to finish; it pushed b 5 min ago");
    expect(t.state(row("waiting"))).toBe("working");
    advance(PUSHED_QUIET_MS);
    expect(await t.atWork(row("waiting"), false, 10)).toBe(false);
    expect(t.state(row("waiting"))).toBe("dormant");
  });

  test("a trusted in-turn status holds the wait after a push, through any silence; one quiet past the trust window reads idle", async () => {
    const { t, row, advance, at } = turn(["a", "b"]);
    await t.begin();
    advance(MIN);
    expect(await t.atWork(row("working"), false, 10)).toBe(true);
    advance(16 * MIN);
    expect(await t.atWork(row("working"), false, 10)).toBe(true);
    expect(t.state(row("working"))).toBe("working");
    // The server's trust decay: an in-turn status whose session synced nothing for an hour is idle.
    const stale = { ...row("working"), ts: at() - 61 * MIN };
    expect(await t.atWork(stale, false, 10)).toBe(false);
  });

  test("the quiet window counts from the transcript's last move", async () => {
    const { t, row, advance } = turn(["a", "b"]);
    await t.begin();
    advance(MIN);
    expect(await t.atWork(row("waiting", 30), false, 10)).toBe(true);
    advance(PUSHED_QUIET_MS - MIN);
    expect(await t.atWork(row("waiting", 31), true, 10)).toBe(true);
    advance(PUSHED_QUIET_MS - MIN);
    expect(await t.atWork(row("waiting", 31), false, 10)).toBe(true);
    advance(2 * MIN);
    expect(await t.atWork(row("waiting", 31), false, 10)).toBe(false);
  });

  test("a head that could not be read at the brief is read again on a later poll; a branch origin lacked at the brief counts once it appears", async () => {
    const failed = turn([undefined, undefined, "a", "b"]);
    await failed.t.begin();
    for (let i = 0; i < 3; i++) { failed.advance(MIN); await failed.t.atWork(failed.row("waiting"), false, 10); }
    expect(failed.said).toEqual(["waiting for jx7abcd to finish; it pushed b just now"]);
    const absent = turn([null, "c"]);
    await absent.t.begin();
    absent.advance(MIN);
    await absent.t.atWork(absent.row("waiting"), false, 10);
    expect(absent.said).toEqual(["waiting for jx7abcd to finish; it pushed c just now"]);
  });

  test("no branch to read never answers by a push", async () => {
    let now = 0;
    const t = await new SubjectTurn({ cwd: "/repo", branch: null, shortId: "jx7abcd", say: () => {}, now: () => now, readHead: async () => "x" }).begin();
    now += PUSHED_QUIET_MS * 4;
    expect(await t.atWork({ work_state: "working", agent_status: "waiting", message_count: 30, ts: now }, false, 10)).toBe(true);
  });
});
