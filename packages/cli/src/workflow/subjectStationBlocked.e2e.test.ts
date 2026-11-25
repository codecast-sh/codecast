// End to end (flows.md FL4): a subject that pins blocked at its own station. The run waits for a person and goes on
// when the session next ends a turn; a killed session's blocked pin stops the run (ct-101065). Same sandbox and fake
// server as subjectStation.e2e.test.ts.
import { describe, expect, spyOn, test } from "bun:test";
import { CONV, git, sandbox, server, start, useSandbox, world } from "./subjectStation.testkit";

useSandbox();

describe("a subject that pins blocked at its own station: the run waits for a person (ct-101065)", () => {
  const PIN = "Waiting for Jason: GitHub billing stopped CI's runners";
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  /**
   * The session pins blocked when the brief reaches it and goes quiet. `answerAfter` reads of its row later a person
   * has answered: it works, fixes a.txt and ends its turn pinned `answer` (with none, it never comes back). `ended`
   * says when the run reads as over on the server (a cancel). `killedAfter`: its row reads killed from that many reads
   * into the wait (0: killed already when its blocked pin is first read).
   */
  function asksAPerson(edit: (t: string) => void, opts: { answer?: "done" | "dormant"; answerAfter?: number; ended?: (parkedReads: number) => boolean; killedAfter?: number }) {
    let phase: "brief" | "blocked" | "working" | "answered" = "brief";
    let pinnedAt = 0;
    let parkedReads = 0;
    let pinReadsWhileBlocked = 0;
    const s = server(() => {}, {
      row: (briefed) => {
        if (!briefed) return {};
        if (phase === "brief") phase = "blocked";
        if (phase === "blocked" && opts.killedAfter !== undefined && parkedReads >= opts.killedAfter) {
          if (pinnedAt) parkedReads++;
          return { is_killed: true, is_live: false };
        }
        if (phase === "blocked" && pinnedAt && ++parkedReads >= (opts.answerAfter ?? 8) && opts.answer) {
          phase = "working";
          return { work_state: "working", agent_status: "working", message_count: 20 };
        }
        if (phase === "working") {
          edit("good\n");
          phase = "answered";
        }
        return phase === "answered" ? { work_state: opts.answer === "dormant" ? "dormant" : "done", message_count: 25 } : {};
      },
    });
    const serve = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      const route = String(url).replace(/^https?:\/\/[^/]+/, "");
      if (route === "/cli/workflow-runs/poll-gate" && phase === "blocked" && opts.ended?.(parkedReads)) {
        s.calls.push({ route, body: JSON.parse(init?.body || "{}") });
        return json({ status: "failed" });
      }
      if (route !== "/cli/sessions/state/get") return serve(url, init);
      s.calls.push({ route, body: JSON.parse(init?.body || "{}") });
      if (phase === "blocked") {
        pinnedAt ||= Date.now();
        pinReadsWhileBlocked++;
        return json({ state: PIN, status: "blocked", at: pinnedAt });
      }
      if (phase === "answered") return json({ state: "Fixed a.txt", status: opts.answer, at: Date.now() });
      return json({});
    }) as typeof fetch;
    return { s, parkedReads: () => parkedReads, pinReadsWhileBlocked: () => pinReadsWhileBlocked };
  }
  const waits = (s: ReturnType<typeof server>) => s.calls.filter((c) => c.route === "/cli/workflow-runs/progress" && "waiting_on_session" in c.body).map((c) => c.body.waiting_on_session);

  for (const answer of ["done", "dormant"] as const) {
    test(`the run waits, its row says so with the pin, and the session's next turn that ends ${answer} answers the station`, async () => {
      const { root, edit } = world("bad\n");
      const p = asksAPerson(edit, { answer, answerAfter: 8 });
      const { outcome } = await start(root);
      expect(outcome).toBe("completed");
      expect(p.s.sent().filter((m) => /^Check failed/.test(m.body))).toHaveLength(1);
      expect(git(root, "show", "codecast/change-ct-9:a.txt")).toBe("good");
      // Fixing, then waiting for a person with its pin, then fixing again once it is back at work, then settled.
      const w = waits(p.s);
      expect(w[0]).toMatchObject({ node_id: "fix_check", conversation_id: CONV });
      expect(w[0].blocked).toBeUndefined();
      expect(w[1]).toMatchObject({ node_id: "fix_check", conversation_id: CONV, note: PIN, blocked: true });
      expect(w[2]).toEqual(w[0]);
      expect(w[3]).toBeNull();
      expect(w).toHaveLength(4);
      // Never a stop: no fail reason, no "waiting on a person".
      expect(p.s.calls.some((c) => c.route === "/cli/workflow-runs/progress" && c.body.fail_reason)).toBe(false);
      // The wait is cheap: a quiet transcript is not read for a pin again, and each poll asks whether the run ended.
      expect(p.parkedReads()).toBeGreaterThanOrEqual(8);
      expect(p.pinReadsWhileBlocked()).toBe(1);
      expect(p.s.calls.filter((c) => c.route === "/cli/workflow-runs/poll-gate").length).toBeGreaterThanOrEqual(8);
    }, 60_000);
  }

  const failReasons = (s: ReturnType<typeof server>) => s.calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.fail_reason).map((c) => String(c.body.fail_reason));

  test("a killed session's blocked pin is the station's stop, as before: there is no next turn to wait for", async () => {
    const { root, edit } = world("bad\n");
    const p = asksAPerson(edit, { killedAfter: 0 });
    const { outcome } = await start(root);
    expect(outcome).toBe("failed");
    expect(failReasons(p.s).at(-1)).toBe("fix_check is waiting on a person");
    expect(waits(p.s).some((w) => w?.blocked)).toBe(false);
    expect(p.s.sent().filter((m) => /^Check failed/.test(m.body))).toHaveLength(1);
  }, 60_000);

  test("a session killed while the run waits for a person ends the wait on the next read, with the station's stop", async () => {
    const { root, edit } = world("bad\n");
    const p = asksAPerson(edit, { killedAfter: 5 });
    const { outcome } = await start(root);
    expect(outcome).toBe("failed");
    expect(waits(p.s).find((w) => w?.blocked)).toMatchObject({ note: PIN, blocked: true });
    expect(p.parkedReads()).toBeGreaterThanOrEqual(6);
    expect(failReasons(p.s).at(-1)).toBe("fix_check is waiting on a person");
  }, 60_000);

  test("a session that never comes back is waited for past its station's limit and quiet window; only a cancel ends the run", async () => {
    const { root, edit } = world("bad\n");
    // Each read is 45 minutes on: twelve hours of waiting before the cancel.
    const realAwake = performance.now.bind(performance);
    let shift = 0;
    const awake = spyOn(performance, "now").mockImplementation(() => realAwake() + shift);
    try {
      const p = asksAPerson(edit, { ended: (reads) => { shift += 45 * 60_000; return reads >= 16; } });
      const { outcome } = await start(root);
      expect(outcome).toBe("failed");
      expect(p.parkedReads()).toBeGreaterThanOrEqual(16);
      // Nothing gave it up before the cancel: no hand killed, no stop reported, the session sent nothing more.
      expect(p.s.calls.some((c) => c.route === "/cli/workflow-runs/progress" && c.body.fail_reason)).toBe(false);
      expect(p.s.sent().filter((m) => /^Check failed/.test(m.body))).toHaveLength(1);
      expect(waits(p.s).at(-1)).toMatchObject({ blocked: true, note: PIN });
    } finally {
      awake.mockRestore();
    }
  }, 60_000);
});
