// End to end (flows.md FL4): a session's change is the run's subject. Its check
// fails, the failure comes back to the session as a message, the session fixes
// its own checkout, the run freezes the change again and Check passes on it.
// The session hears Decide's answer and how the run ended. Real git and real
// transcripts in an isolated CODECAST_DIR and HOME; the server is a fake that
// plays the session.
import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import nodeOs from "node:os";
import * as path from "node:path";
import { writeFrozenChange } from "./flowChange";
import { readFrozenChange } from "./flowChangeFile";
import { parseWorkflowSource } from "./parser";
import { lineRunDir, runSlug, runWorkflow } from "./runner";
import { readCheckpoint } from "./runResume";
import { startSubjectParker } from "./subjectPark";
import { failureExcerpt, runEndMessage } from "./subjectStation";
import { CONV, git, graphIn, origLog, sandbox, server, start, useSandbox, world, worlds } from "./subjectStation.testkit";

useSandbox();

describe("the session is the run's subject", () => {
  test("a failed check comes back to the session, it fixes it, the run freezes again and goes on; it hears the answer and the end", async () => {
    const { root, edit } = world("bad\n");
    const s = server(() => edit("good\n"));
    const { outcome, runDir } = await start(root);
    expect(outcome).toBe("completed");

    const [brief, answer, end] = s.sent();
    expect(brief.to).toBe(CONV);
    expect(brief.from).toBe("conv_run");
    expect(brief.body).toContain("Check failed on ct-9");
    expect(brief.body).toContain("error: a.txt says bad, expected good");
    expect(answer.body).toMatch(/^Decide: Ship\./);
    // The gate's answer is news: quiet, so a subject out of sight stays there.
    expect(answer.quiet).toBe(true);
    expect(end.quiet).toBeUndefined();
    expect(end.body).toContain("The Change run on ct-9 is over: Done.");
    expect(s.sent()).toHaveLength(3);

    // What ships is the snapshot the run checked: the frozen branch holds the fix, the shared tree is untouched.
    expect(git(root, "show", "codecast/change-ct-9:a.txt")).toBe("good");
    expect(readFrozenChange(runDir)?.tip).toBe(git(root, "rev-parse", "codecast/change-ct-9"));
    expect(git(root, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "main"));
    expect(git(root, "status", "--porcelain", "--", "a.txt")).toBe(" M a.txt");

    // The run said it waited on the session, and then that it no longer does; Check's second visit is counted.
    const progress = s.calls.filter((c) => c.route === "/cli/workflow-runs/progress").map((c) => c.body);
    const waits = progress.filter((b) => "waiting_on_session" in b).map((b) => b.waiting_on_session);
    expect(waits[0]).toMatchObject({ node_id: "fix_check", conversation_id: CONV });
    expect(waits[0].note).toContain("expected good");
    expect(waits[1]).toBeNull();
    expect(progress.some((b) => b.node_id === "check" && b.visits === 2)).toBe(true);
    // The session is never reported as a hand of the run's.
    expect(progress.some((b) => b.session_id)).toBe(false);
  }, 60_000);

  // A finding names the run's worktree, so the subject may fix it there and end its turn with nothing committed (ct-99118).
  test("a fix left uncommitted in the run's worktree reaches the next Check, on top of the checkout's change", async () => {
    const { root } = world("bad\n");
    const tree = path.join(root, ".codecast", "worktrees", "change-ct-9");
    const s = server(() => fs.writeFileSync(path.join(tree, "a.txt"), "good\n"));
    const { outcome, runDir } = await start(root);
    expect(outcome).toBe("completed");
    expect(s.sent()[0].body).toContain("error: a.txt says bad, expected good");
    expect(git(root, "show", "codecast/change-ct-9:a.txt")).toBe("good");
    const change = readFrozenChange(runDir)!;
    expect(change.tip).toBe(git(root, "rev-parse", "codecast/change-ct-9"));
    expect(change.paths).toEqual(["a.txt"]);
    // The checkout is the subject's and stays as it was; the run's worktree is the change, with nothing of the subject's left over.
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf-8")).toBe("bad\n");
    expect(git(tree, "status", "--porcelain", "--", "a.txt")).toBe("");
  }, 60_000);

  test("a session that pins dormant naming the run as its wake has answered: the run goes on (ct-85419)", async () => {
    const { root, edit } = world("bad\n");
    const s = server(() => edit("good\n"), { dormant: true });
    const { outcome } = await start(root);
    expect(outcome).toBe("completed");
    expect(s.sent().at(-1)!.body).toContain("is over: Done.");
  }, 60_000);

  test("a dormant pin from before the brief is not its answer: the run waits for the turn the brief started to end (ct-98624)", async () => {
    const { root, edit } = world("bad\n");
    // Its row reads dormant throughout (the pin it left last turn). After the brief it works a while, between tool
    // calls too (an idle status while the transcript grows), fixes a.txt at the end of the turn and goes quiet.
    let reads = 0;
    const s = server(() => {}, {
      dormant: true,
      pinnedAt: Date.now() - 3_600_000,
      row: (briefed) => {
        if (!briefed) return {};
        reads++;
        if (reads < 12) return { agent_status: reads % 4 ? "working" : "idle", message_count: 20 + reads };
        if (reads === 12) edit("good\n");
        return { agent_status: "idle", message_count: 40 };
      },
    });
    const { outcome } = await start(root);
    expect(outcome).toBe("completed");
    expect(reads).toBeGreaterThanOrEqual(14);
    // One brief: the run froze the change only once the turn had ended, so Check passed on the fix.
    expect(s.sent().filter((m) => /^Check failed/.test(m.body))).toHaveLength(1);
    expect(git(root, "show", "codecast/change-ct-9:a.txt")).toBe("good");
  }, 60_000);

  test("a subject whose dormant pin predates its brief and that never answers is given up at its quiet window, not its cap", async () => {
    // It pinned dormant naming the run, then wedged on resume: its row still reads dormant on that old claim, and its
    // transcript never moves. Each read after the brief is 45 minutes on, on an idle machine.
    const { root } = world("bad\n");
    const realAwake = performance.now.bind(performance);
    let shift = 0;
    const awake = spyOn(performance, "now").mockImplementation(() => realAwake() + shift);
    const load = spyOn(nodeOs, "loadavg").mockReturnValue([0, 0, 0]);
    try {
      const s = server(() => {}, {
        dormant: true,
        pinnedAt: Date.now() - 3_600_000,
        lag: 1e9,
        row: (briefed) => {
          if (briefed) shift += 45 * 60_000;
          return {};
        },
      });
      const { outcome } = await start(root);
      expect(outcome).toBe("failed");
      const reasons = s.calls.filter((c) => c.route === "/cli/workflow-runs/progress" && c.body.fail_reason).map((c) => String(c.body.fail_reason));
      expect(reasons.at(-1)).toContain("(it showed no work for 30m)");
    } finally {
      awake.mockRestore();
      load.mockRestore();
    }
  }, 60_000);

  test("a turn that ends before the brief reaches it is no answer: the run waits for the brief's delivery (a detached run's caller)", async () => {
    const { root, edit } = world("bad\n");
    // The caller is mid-turn when the check fails: its turn ends (the transcript grows, it reads done) while the brief
    // waits in its queue. The brief lands on the fourth read of its status, and the session fixes a.txt then.
    const s = server(() => {});
    const serve = globalThis.fetch;
    let statusReads = 0;
    let deliveredAt = 0;
    globalThis.fetch = (async (url: any, init: any) => {
      if (!String(url).endsWith("/cli/messages/status")) return serve(url, init);
      s.calls.push({ route: "/cli/messages/status", body: JSON.parse(init?.body || "{}") });
      if (++statusReads === 4) {
        edit("good\n");
        deliveredAt = Date.now();
      }
      const send = deliveredAt ? { created_at: deliveredAt - 1000, status: "delivered", delivered_at: deliveredAt } : { created_at: Date.now(), status: "pending" };
      return new Response(JSON.stringify({ sends: [send] }), { status: 200 });
    }) as typeof fetch;
    const { outcome } = await start(root);
    expect(outcome).toBe("completed");
    expect(statusReads).toBeGreaterThanOrEqual(4);
    // One brief: the turn that ended before it landed was not taken for the fix.
    expect(s.sent().filter((m) => /^Check failed/.test(m.body))).toHaveLength(1);
    expect(git(root, "show", "codecast/change-ct-9:a.txt")).toBe("good");
  }, 60_000);

  test("a session that never fixes it is sent back three times, then the run stops and says why", async () => {
    const { root } = world("bad\n");
    const s = server(() => {});
    const { outcome } = await start(root);
    expect(outcome).toBe("failed");
    const sent = s.sent();
    expect(sent.filter((m) => /^Check failed/.test(m.body))).toHaveLength(3);
    expect(sent.at(-1)!.body).toContain("stopped at Fix check: Check sent the change back 3 times and it still does not pass.");
  }, 60_000);
});

describe("the subject between its turns: restarted, parked, retired", () => {
  const routes = (s: ReturnType<typeof server>, route: string) => s.calls.filter((c) => c.route === route).map((c) => c.body);
  const indexOf = (s: ReturnType<typeof server>, match: (c: { route: string; body: any }) => boolean) => s.calls.findIndex(match);

  test("a killed subject is sent the brief like any other, which restarts it, and the run completes", async () => {
    const { root, edit } = world("bad\n");
    const s = server(() => edit("good\n"), { row: (briefed) => (briefed ? {} : { is_killed: true, is_live: false, work_state: "idle" }) });
    const { outcome } = await start(root);
    expect(outcome).toBe("completed");
    expect(s.sent()[0].body).toContain("Check failed on ct-9");
    expect(git(root, "show", "codecast/change-ct-9:a.txt")).toBe("good");
  }, 60_000);

  test("a settled subject stays in the inbox and is asked to park while Check runs, never during its own station; its brief is quiet", async () => {
    const { root, edit } = world("bad\n");
    const s = server(() => edit("good\n"), { lag: 30 });
    const { outcome } = await start(root, graphIn(root), { run: { subjectParkMs: 1 } });
    expect(outcome).toBe("completed");
    const [brief] = s.sent();
    expect(brief.quiet).toBe(true);
    // The live run is its wake, so it files under Dormant: the run never stashes it out of sight.
    expect(routes(s, "/cli/sessions/dismiss")).toEqual([]);
    expect(routes(s, "/cli/sessions/hibernate")[0]).toEqual({ api_token: "tok", session: CONV });
    // Hibernate is asked again no sooner than five minutes later.
    expect(routes(s, "/cli/sessions/hibernate")).toHaveLength(1);
    // Nothing parks the session between its brief and its settle, though it read settled through the whole lag.
    const sentAt = indexOf(s, (c) => c.route === "/cli/messages/send" && /^Check failed/.test(c.body.body));
    const settledAt = indexOf(s, (c) => c.route === "/cli/workflow-runs/progress" && c.body.waiting_on_session === null);
    const parkedDuring = s.calls.slice(sentAt, settledAt).filter((c) => c.route === "/cli/sessions/hibernate");
    expect(settledAt - sentAt).toBeGreaterThan(30);
    expect(parkedDuring).toEqual([]);
    // The quiet brief's run sends the end message as usual: the change did not land.
    expect(s.sent().at(-1)!.body).toContain("is over: Done.");
  }, 60_000);

  test("a working subject is left alone", async () => {
    const { root } = world("good\n");
    const s = server(() => {}, { row: () => ({ work_state: "working" }) });
    expect((await start(root, graphIn(root), { run: { subjectParkMs: 1 } })).outcome).toBe("completed");
    expect(routes(s, "/cli/sessions/dismiss")).toEqual([]);
    expect(routes(s, "/cli/sessions/hibernate")).toEqual([]);
  }, 60_000);

  test("a subject that settles in the middle of a long station is parked then, not only between stations", async () => {
    const { root } = world("good\n");
    // It works until a moment after Wait has started, then settles.
    let settleAt = Infinity;
    const waitRunning = (c: { route: string; body: any }) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "wait" && c.body.node_status === "running";
    const s: ReturnType<typeof server> = server(() => {}, {
      row: () => {
        if (settleAt === Infinity && s.calls.some(waitRunning)) settleAt = Date.now() + 200;
        return Date.now() < settleAt ? { work_state: "working" } : {};
      },
    });
    const graph = parseWorkflowSource(`digraph slow {
      graph [label="Slow"]
      start [shape=Mdiamond]
      wait [label="Wait", shape=parallelogram, script="sleep 1"]
      exit [shape=Msquare, label="Done"]
      start -> wait -> exit
    }`, root);
    expect((await start(root, graph, { run: { subjectParkMs: 20 } })).outcome).toBe("completed");
    const waitRan = indexOf(s, waitRunning);
    const waitDone = indexOf(s, (c) => c.route === "/cli/workflow-runs/progress" && c.body.node_id === "wait" && c.body.node_status === "completed");
    const parked = indexOf(s, (c) => c.route === "/cli/sessions/hibernate");
    expect(parked).toBeGreaterThan(waitRan);
    expect(parked).toBeLessThan(waitDone);
  }, 60_000);

  test("a subject a person wrote to after the run began is parked no more, and the run's context remembers it", async () => {
    const { root } = world("good\n");
    // Once the run has asked to park it, a person types to it.
    const hibernated = () => s.calls.filter((c) => c.route === "/cli/sessions/hibernate").length;
    const s: ReturnType<typeof server> = server(() => {}, {
      row: () => {
        if (!hibernated()) return {};
        // Wait ends once the run has read the person's turn, however slow the machine.
        fs.writeFileSync(`${root}.go`, "");
        return { last_person_turn_at: Date.now() };
      },
    });
    const graph = parseWorkflowSource(`digraph slow {
      graph [label="Slow"]
      start [shape=Mdiamond]
      wait [label="Wait", shape=parallelogram, script="while [ ! -f ${root}.go ]; do sleep 0.05; done"]
      after [label="After", shape=parallelogram, script="true"]
      exit [shape=Msquare, label="Done"]
      start -> wait -> after -> exit
    }`, root);
    const { outcome, runDir } = await start(root, graph, { run: { subjectParkMs: 20 } });
    expect(outcome).toBe("completed");
    expect(hibernated()).toBe(1);
    expect(routes(s, "/cli/sessions/dismiss")).toEqual([]);
    expect(readCheckpoint(runDir, "run-9")?.context.subject_kept).toBe("1");
  }, 60_000);

  // The parker alone, against a row it reads: what counts as a person taking the subject over.
  const parkerOn = (rowOf: () => Record<string, unknown>) => {
    const calls: string[] = [];
    const parker = startSubjectParker(async (route) => {
      calls.push(route);
      return { sessions: [{ id: CONV, work_state: "done", bucket: "dormant", is_live: true, message_count: 3, ...rowOf() }] };
    }, { conversationId: CONV, shortId: "jx7ssss" }, 60_000, () => {});
    return { parker, calls };
  };

  test("once a person has written to the subject, the parker stops: no more reads, no more parking", async () => {
    let turn: Record<string, unknown> = {};
    const { parker, calls } = parkerOn(() => turn);
    const context: Record<string, string> = {};
    parker.bind(context);
    await parker.tick();
    expect(calls.filter((r) => r === "/cli/sessions/hibernate")).toHaveLength(1);
    turn = { last_person_turn_at: Number(context.subject_watch_since) + 1 };
    await parker.tick();
    expect(context.subject_kept).toBe("1");
    const seen = calls.length;
    await parker.tick();
    await parker.stop();
    expect(calls.length).toBe(seen);
  });

  test("a person's turn from before the run began, or a machine turn since, is not a takeover", async () => {
    let turn: Record<string, unknown> = {};
    const { parker, calls } = parkerOn(() => turn);
    const context: Record<string, string> = {};
    parker.bind(context);
    const since = Number(context.subject_watch_since);
    expect(since).toBeGreaterThan(0);
    // The person's "ship it" that started the run.
    turn = { last_person_turn_at: since - 1 };
    await parker.tick();
    // The run's own brief, or another session's message.
    turn = { last_person_turn_at: since - 1, last_turn_origin: "machine", last_turn_at: since + 1 };
    await parker.tick();
    await parker.stop();
    expect(context.subject_kept).toBeUndefined();
    expect(calls).toContain("/cli/sessions/hibernate");
  });

  test("a resumed runner keeps the first watch time, so a person's turn during the gap still counts", async () => {
    const { parker } = parkerOn(() => ({ last_person_turn_at: 1_500 }));
    const context: Record<string, string> = { subject_watch_since: "1000" };
    parker.bind(context);
    expect(context.subject_watch_since).toBe("1000");
    await parker.tick();
    await parker.stop();
    expect(context.subject_kept).toBe("1");
  });

  test("a parker does nothing until it is bound to the run's context, so a resumed runner reads subject_kept first", async () => {
    const calls: string[] = [];
    const read = async (route: string) => { calls.push(route); return { sessions: [{ id: CONV, work_state: "done", bucket: "done", is_live: true, message_count: 3 }] }; };
    const kept = startSubjectParker(read, { conversationId: CONV, shortId: "jx7ssss" }, 1, () => {});
    await kept.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
    kept.bind({ subject_kept: "1" });
    await new Promise((r) => setTimeout(r, 30));
    await kept.stop();
    expect(calls).toEqual([]);
    const fresh = startSubjectParker(read, { conversationId: CONV, shortId: "jx7ssss" }, 1, () => {});
    fresh.bind({});
    await new Promise((r) => setTimeout(r, 30));
    await fresh.stop();
    expect(calls).toContain("/cli/sessions/hibernate");
  });

  test("a parker bound to a run whose context says a person kept the subject does nothing", async () => {
    const calls: string[] = [];
    const parker = startSubjectParker(async (route) => { calls.push(route); return { sessions: [{ id: CONV, work_state: "done", bucket: "done", is_live: true, message_count: 3 }] }; }, { conversationId: CONV, shortId: "jx7ssss" }, 60_000, () => {});
    parker.bind({ subject_kept: "1" });
    await parker.tick();
    await parker.stop();
    expect(calls.filter((r) => r !== "/cli/inbox")).toEqual([]);
  });

  test("every send to the subject carries one client_id; a server that refuses quiet gets the same send plain, under the same id", async () => {
    const { root, edit } = world("bad\n");
    const s = server(() => edit("good\n"), { refuseQuiet: true });
    expect((await start(root)).outcome).toBe("completed");
    const briefs = s.sent().filter((m) => /^Check failed/.test(m.body));
    expect(briefs.map((b) => b.quiet)).toEqual([true, undefined]);
    expect(briefs[0].client_id).toMatch(/^run:run-9:fix_check:[0-9a-f]{8}$/);
    expect(briefs[1].client_id).toBe(briefs[0].client_id);
    const answers = s.sent().filter((m) => /^Decide: Ship\./.test(m.body));
    expect(answers.map((a) => a.quiet)).toEqual([true, undefined]);
    expect(answers[0].client_id).toMatch(/^run:run-9:decide\.answer:[0-9a-f]{8}$/);
    expect(answers[1].client_id).toBe(answers[0].client_id);
    expect(s.sent().at(-1)!.client_id).toMatch(/^run:run-9:end:[0-9a-f]{8}$/);
  }, 60_000);

  test("a second Revise and a second answer on the same gate each reach the subject: no send repeats another's client_id", async () => {
    const { root } = world("good\n");
    // A person answers Revise twice, then Wait (a look again that comes back to the card), then Ship. Each answer
    // starts the visit counts over, so a key built on them repeated, and the server dropped the repeat.
    const graph = parseWorkflowSource(`digraph change {
      graph [label="Change", on_failure=stop]
      start [shape=Mdiamond]
      check [flow="tcheck"]
      decide [label="Decide", shape=hexagon, prompt="Ship it?"]
      revise [label="Revise", backend=subject, max_visits=3, prompt="Revise on $task_id: $human.message"]
      look [label="Look", shape=parallelogram, script="true"]
      exit [shape=Msquare, label="Done"]
      start -> check -> decide
      decide -> revise [label="[R] Revise :: Change it"]
      decide -> look [label="[W] Wait :: Look again"]
      decide -> exit [label="[S] Ship :: Land it"]
      revise -> check
      look -> decide
    }`, root);
    const s = server(() => {}, { answers: ["R", "R", "W", "S"] });
    expect((await start(root, graph)).outcome).toBe("completed");
    const delivered = s.delivered();
    expect(delivered.filter((m) => /^Revise on ct-9/.test(m.body))).toHaveLength(2);
    expect(delivered.filter((m) => /^Decide: /.test(m.body)).map((m) => m.body.split(".")[0])).toEqual(["Decide: Wait", "Decide: Ship"]);
    const ids = s.sent().map((m) => m.client_id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  const PUSH = "git -C $project_path push -q origin $branch:main";
  /** A checkout with an origin, and a flow whose Land runs `land`: PUSH puts the frozen change on origin's main, `true` lands nothing. */
  function landWorld(land: string) {
    const w = world("good\n");
    // Under a github.com path, so the checkout names its repository the way a GitHub origin does.
    const origin = path.join(sandbox, "github.com", "acme", `app-${worlds}.git`);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    git(w.root, "remote", "add", "origin", origin);
    git(w.root, "push", "-q", "origin", "main");
    git(w.root, "fetch", "-q", "origin");
    const graph = parseWorkflowSource(`digraph change {
      graph [label="Change", on_failure=stop]
      start [shape=Mdiamond]
      check [flow="tcheck"]
      land [label="Land", shape=parallelogram, script="${land}"]
      exit [shape=Msquare, label="Done"]
      start -> check -> land -> exit
    }`, w.root);
    return { ...w, graph };
  }

  test("a subject whose change is live and that has no other work is retired: killed, not told", async () => {
    const { root, graph } = landWorld(PUSH);
    const s = server(() => {});
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(git(root, "show", "origin/main:a.txt")).toBe("good");
    // Retired through the server's guarded kill, with the transcript length the run read it settled at.
    expect(routes(s, "/cli/sessions/retire")).toEqual([{ api_token: "tok", session: CONV, expected_message_count: 10 }]);
    expect(routes(s, "/cli/sessions/kill")).toEqual([]);
    expect(routes(s, "/cli/deploys/targets")[0]).toMatchObject({ repository: `acme/app-${worlds}` });
    expect(s.sent()).toEqual([]);
    const end = routes(s, "/cli/workflow-runs/progress").find((b) => b.run_status === "completed");
    expect(end.result_preview).toMatch(/^Retired jx7ssss: its change is live from main at [0-9a-f]{10} and it has no other work\.$/);
  }, 60_000);

  test("a subject a person wrote to while the run went on is never retired: it hears the end instead", async () => {
    const w = landWorld(PUSH);
    // Land waits until the run has read the person's turn, after asking to park it.
    const graph = parseWorkflowSource(`digraph change {
      graph [label="Change", on_failure=stop]
      start [shape=Mdiamond]
      land [label="Land", shape=parallelogram, script="while [ ! -f ${w.root}.go ]; do sleep 0.05; done; ${PUSH}"]
      exit [shape=Msquare, label="Done"]
      start -> land -> exit
    }`, w.root);
    const s: ReturnType<typeof server> = server(() => {}, {
      row: () => {
        if (!routes(s, "/cli/sessions/hibernate").length) return {};
        fs.writeFileSync(`${w.root}.go`, "");
        return { last_person_turn_at: Date.now() };
      },
    });
    const { outcome, runDir } = await start(w.root, graph, { run: { subjectParkMs: 20 } });
    expect(outcome).toBe("completed");
    expect(git(w.root, "show", "origin/main:a.txt")).toBe("good");
    expect(readCheckpoint(runDir, "run-9")?.context.subject_kept).toBe("1");
    expect(routes(s, "/cli/sessions/retire")).toEqual([]);
    expect(s.sent().at(-1)!.body).toContain("is over: Done.");
  }, 60_000);

  test("a parked subject is retired too, and is not resumed to hear a gate's answer", async () => {
    const { root } = landWorld(PUSH);
    const graph = parseWorkflowSource(`digraph change {
      graph [label="Change", on_failure=stop]
      start [shape=Mdiamond]
      decide [label="Decide", shape=hexagon, prompt="Ship it?"]
      land [label="Land", shape=parallelogram, script="git -C $project_path push -q origin $branch:main"]
      exit [shape=Msquare, label="Done"]
      start -> decide
      decide -> land [label="[S] Ship :: Land it"]
      land -> exit
    }`, root);
    const s = server(() => {}, { row: () => ({ is_live: false, agent_status: "hibernated" }) });
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(s.sent()).toEqual([]);
    expect(routes(s, "/cli/sessions/retire")).toHaveLength(1);
    // Nothing to park: it already is.
    expect(routes(s, "/cli/sessions/hibernate")).toEqual([]);
  }, 60_000);

  test("merged is not live: a touched target still running a deploy from before the change keeps the subject, who hears the end", async () => {
    const { root, graph } = landWorld(PUSH);
    const before = git(root, "rev-parse", "main");
    const s = server(() => {}, { targets: () => [{ name: "web", paths: ["a.txt"], live: { short_id: "dp-1", status: "live", sha: before, created_at: 1, live_at: 1 } }] });
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(routes(s, "/cli/sessions/retire")).toEqual([]);
    expect(s.sent().at(-1)!.body).toContain("The Change run on ct-9 is over: Done.");
  }, 60_000);

  test("a touched target live at a deploy that holds the change retires the subject; a target the change does not touch is not waited on", async () => {
    const { root, graph } = landWorld(PUSH);
    const before = git(root, "rev-parse", "main");
    const s = server(() => {}, {
      targets: () => [
        { name: "web", paths: ["a.txt"], live: { short_id: "dp-2", status: "live", sha: git(root, "rev-parse", "origin/main"), created_at: 2, live_at: 2 } },
        { name: "docs", paths: ["docs/**"], live: { short_id: "dp-3", status: "live", sha: before, created_at: 1, live_at: 1 } },
      ],
    });
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(routes(s, "/cli/sessions/retire")).toHaveLength(1);
    expect(s.sent()).toEqual([]);
  }, 60_000);

  test("a target the checkout declares but the server has never listed is not live: the subject stays", async () => {
    const { root, graph } = landWorld(PUSH);
    fs.mkdirSync(path.join(root, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codecast", "deploy.toml"), `[[target]]\nname = "web"\nruns = "push"\nwhen = ["a.txt"]\nlive = "marker"\n`);
    git(root, "add", ".codecast/deploy.toml");
    git(root, "commit", "-qm", "declare web");
    const s = server(() => {});
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(routes(s, "/cli/sessions/retire")).toEqual([]);
    expect(s.sent().at(-1)!.body).toContain("The Change run on ct-9 is over: Done.");
  }, 60_000);

  test("a retire the server refuses (the session moved, a trigger is armed) leaves the subject, who hears the end", async () => {
    const { root, graph } = landWorld(PUSH);
    const s = server(() => {}, { retire: () => ({ retired: false, short_id: "jx7ssss", reason: "a trigger is armed on it" }) });
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(routes(s, "/cli/sessions/retire")).toHaveLength(1);
    expect(s.sent().at(-1)!.body).toContain("The Change run on ct-9 is over: Done.");
  }, 60_000);

  test("a subject whose checkout has nothing uncommitted left (it pulled the landed main) is retired", async () => {
    const { root, graph } = landWorld(`${PUSH} && git -C $project_path reset -q --hard origin/main`);
    const s = server(() => {});
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(git(root, "status", "--porcelain", "--", "a.txt")).toBe("");
    expect(routes(s, "/cli/sessions/retire")).toHaveLength(1);
    expect(s.sent()).toEqual([]);
  }, 60_000);

  test("a run that completes says nothing to a subject already stopped: no revival to read that it is over", async () => {
    const { root, graph } = landWorld("true");
    const s = server(() => {}, { row: () => ({ is_killed: true, is_live: false, work_state: "idle" }) });
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(s.sent()).toEqual([]);
    expect(routes(s, "/cli/sessions/retire")).toEqual([]);
  }, 60_000);

  test("a run that fails still tells a stopped subject, which revives it so the failure reaches someone", async () => {
    const { root } = world("bad\n");
    const graph = parseWorkflowSource(`digraph change {
      graph [label="Change", on_failure=stop]
      start [shape=Mdiamond]
      check [flow="tcheck"]
      stopped [shape=Msquare, label="Checks failed", stop="$stop_reason"]
      exit [shape=Msquare, label="Done"]
      start -> check -> exit
      check -> stopped [condition="outcome = failure"]
    }`, root);
    const s = server(() => {}, { row: () => ({ is_killed: true, is_live: false, work_state: "idle" }) });
    expect((await start(root, graph)).outcome).toBe("failed");
    const told = s.sent();
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain("stopped at Checks failed");
    expect(told[0].quiet).toBeUndefined();
  }, 60_000);

  test("a subject with another file of its own changed stays, and hears the end", async () => {
    const { root, edit, graph } = landWorld(PUSH);
    edit("more work\n", "b.txt");
    const s = server(() => {});
    expect((await start(root, graph, { only: ["a.txt"] })).outcome).toBe("completed");
    expect(git(root, "show", "origin/main:a.txt")).toBe("good");
    expect(routes(s, "/cli/sessions/retire")).toEqual([]);
    expect(s.sent().at(-1)!.body).toContain("The Change run on ct-9 is over: Done.");
  }, 60_000);

  test("a change that did not land leaves its subject, who hears the end", async () => {
    const { root, graph } = landWorld("true");
    const s = server(() => {});
    expect((await start(root, graph)).outcome).toBe("completed");
    expect(routes(s, "/cli/sessions/retire")).toEqual([]);
    expect(s.sent().at(-1)!.body).toContain("The Change run on ct-9 is over: Done.");
  }, 60_000);
});

describe("a change named by branch from inside a session (ct-85594)", () => {
  /** The session committed its change on its own branch and ran `cast flow run change --task ct-9 --branch feat` from inside itself. */
  function branchWorld(content: string) {
    const { root } = world("unused\n");
    git(root, "checkout", "-q", "-b", "feat");
    fs.writeFileSync(path.join(root, "a.txt"), content);
    git(root, "commit", "-qam", "the change");
    git(root, "checkout", "-q", "main");
    // The run's worktree holds the branch, so the session commits from elsewhere: here, with plumbing.
    const commit = (text: string) => {
      const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: text, encoding: "utf-8" }).trim();
      const tree = execFileSync("git", ["-C", root, "mktree"], { input: `100644 blob ${blob}\ta.txt\n`, encoding: "utf-8" }).trim();
      const tip = git(root, "commit-tree", tree, "-p", "feat", "-m", "fix");
      git(root, "update-ref", "refs/heads/feat", tip);
    };
    return { root, commit };
  }

  async function startOnBranch(root: string, graph = graphIn(root), subject = true) {
    const runDir = lineRunDir(root, runSlug(graph, { task_id: "ct-9" }, "run"));
    const tip = git(root, "rev-parse", "feat");
    writeFrozenChange(runDir, { source: "branch", ...(subject ? { session: CONV.slice(0, 7), conversation: CONV } : {}), base: tip, tip, branch: "feat", worktree: "change-ct-9", paths: [], shared: [], held: [] });
    console.log = () => {};
    try {
      return await runWorkflow(graph, { cwd: root, taskId: "ct-9", runId: "run-9", runSession: "conv_run", apiToken: "tok", convexSiteUrl: "https://convex.test", pollIntervalMs: 1 });
    } finally {
      console.log = origLog;
    }
  }

  test("the session that started it is the subject: a failed check reaches it, it commits the fix to the branch, the run reads the branch again", async () => {
    const { root, commit } = branchWorld("bad\n");
    const s = server(() => commit("good\n"));
    expect(await startOnBranch(root)).toBe("completed");
    const [brief] = s.sent();
    expect(brief.to).toBe(CONV);
    expect(brief.body).toContain("error: a.txt says bad, expected good");
    expect(s.calls.some((c) => c.route === "/cli/work/comment" && c.body.comment_type === "blocker")).toBe(false);
  }, 60_000);

  test("a fix left uncommitted in the run's worktree is committed to the branch and checked, not reset away (ct-99118)", async () => {
    const { root } = branchWorld("bad\n");
    const tree = path.join(root, ".codecast", "worktrees", "change-ct-9");
    const s = server(() => {
      fs.writeFileSync(path.join(tree, "a.txt"), "good\n");
      fs.writeFileSync(path.join(tree, "new.txt"), "a test it added\n");
    });
    expect(await startOnBranch(root)).toBe("completed");
    expect(s.sent()[0].body).toContain("error: a.txt says bad, expected good");
    expect(git(root, "show", "feat:a.txt")).toBe("good");
    expect(git(root, "show", "feat:new.txt")).toBe("a test it added");
    // The run's setup wrote its log there before the brief: that is the run's own, neither committed nor removed.
    expect(git(root, "diff", "--name-only", "feat~1", "feat")).toBe("a.txt\nnew.txt");
    expect(git(tree, "status", "--porcelain", "--untracked-files=all")).toMatch(/^\?\? \.codecast\/logs\/setup-[^\n]+\.log$/);
  }, 60_000);

  test("a credential left in the run's worktree is held out, moved into the run's directory, and named in the next brief (ct-99118)", async () => {
    const { root } = branchWorld("bad\n");
    const tree = path.join(root, ".codecast", "worktrees", "change-ct-9");
    let briefs = 0;
    const s = server(() => {
      if (++briefs === 1) fs.writeFileSync(path.join(tree, ".env"), "KEY=1\n");
      else fs.writeFileSync(path.join(tree, "a.txt"), "good\n");
    });
    expect(await startOnBranch(root)).toBe("completed");
    const [, second] = s.sent();
    expect(second.body).toContain("Held out of the change and moved from the run's worktree to ");
    expect(second.body).toContain(".env (named like a credential file)");
    expect(fs.existsSync(path.join(tree, ".env"))).toBe(false);
    expect(() => git(root, "cat-file", "-e", "feat:.env")).toThrow();
  }, 60_000);

  // The check's own segment, shaped like the shipped check.cast: exit 2 is this machine's, not the change's.
  const machineGraph = (root: string) => {
    fs.writeFileSync(path.join(root, "mcheck.cast"), `digraph mcheck {
      graph [kind="segment", label="Check"]
      start [shape=Mdiamond]
      verify [label="Verify", shape=parallelogram, script="echo '{\\"ok\\":false,\\"steps\\":[{\\"name\\":\\"test database\\",\\"ok\\":false,\\"detail\\":\\"role postgres does not exist\\"}]}'; exit 2"]
      passed [shape=Msquare, label="Passed"]
      failed [shape=Msquare, label="Checks failed", stop="The project's check failed on the change: $verify.summary"]
      unjudged [shape=Msquare, label="Not checked here", machine=true, stop="This machine could not run the project's check: $verify.summary."]
      start -> verify
      verify -> passed [condition="outcome = success"]
      verify -> failed [condition="outcome = failure and verify.exit_code != 2"]
      verify -> unjudged [condition="outcome = failure and verify.exit_code = 2"]
    }`);
    return parseWorkflowSource(`digraph change {
      graph [label="Change", on_failure=stop]
      start [shape=Mdiamond]
      check [flow="mcheck"]
      fix_check [label="Fix check", backend=subject, max_visits=3, prompt="Check failed on $task_id.\\n\\n$stop_reason"]
      unchecked [shape=Msquare, label="Not checked here", machine=true, stop="$stop_reason"]
      exit [shape=Msquare, label="Done"]
      start -> check
      check -> exit
      check -> fix_check [condition="outcome = failure and check.exit != unjudged"]
      check -> unchecked [condition="outcome = failure and check.exit = unjudged"]
      fix_check -> check
    }`, root);
  };
  const comments = (s: ReturnType<typeof server>) => s.calls.filter((c) => c.route === "/cli/work/comment").map((c) => c.body);

  test("a check the machine could not run stops at once: a note on the task in the run's voice, the session told, no blocker", async () => {
    const { root } = branchWorld("good\n");
    const s = server(() => { throw new Error("the session is never asked to fix the machine"); });
    expect(await startOnBranch(root, machineGraph(root))).toBe("failed");
    const [note, ...rest] = comments(s);
    expect(rest).toEqual([]);
    expect(note).toMatchObject({ short_id: "ct-9", comment_type: "note", conversation_id: "conv_run" });
    expect(note.to_owner).toBeUndefined();
    expect(note.text).toContain("This machine could not run the project's check: test database (role postgres does not exist).");
    expect(note.text).toContain("Full output: ");
    expect(note.text).toContain("/workflows/runs/run-9");
    expect(note.text).not.toContain("{");
    expect(s.calls.find((c) => c.route === "/cli/work/update")?.body).toMatchObject({ status: "in_review" });
    const told = s.sent();
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain("stopped at Not checked here: This machine could not run the project's check");
  }, 60_000);

  test("with no session behind the run, the note is for the run's owner alone", async () => {
    const { root } = branchWorld("good\n");
    const s = server(() => {});
    expect(await startOnBranch(root, machineGraph(root), false)).toBe("failed");
    expect(comments(s)[0]).toMatchObject({ comment_type: "note", conversation_id: "conv_run", to_owner: true });
    expect(s.sent()).toHaveLength(0);
  }, 60_000);
});

describe("runEndMessage", () => {
  const g = parseWorkflowSource(`digraph "checked" { graph [label="Checked"] start [shape=Mdiamond] exit [shape=Msquare] start -> exit }`);
  test("a stop before Land says nothing merged and how to run it again; one after Land says the change is on main", () => {
    expect(runEndMessage(g, { taskId: "ct-1", endLabel: "Fix check", failed: true, failReason: "Stopped: Check sent the change back 3 times and it still does not pass." }))
      .toBe("The Checked run on ct-1 stopped at Fix check: Check sent the change back 3 times and it still does not pass. The change was not merged. Run it again with `cast flow run checked` once it is ready.");
    expect(runEndMessage(g, { taskId: "ct-1", endLabel: "Deploy failed", failed: true, failReason: "Stopped: The deploy that carried abc failed: web dp-2 (exit 1).", landed: true }))
      .toBe("The Checked run on ct-1 stopped at Deploy failed: The deploy that carried abc failed: web dp-2 (exit 1). The change is on the default branch; nothing after this stage ran.");
  });
});

describe("failureExcerpt", () => {
  test("short output passes whole; long output keeps what broke and the end", () => {
    expect(failureExcerpt("a\n\nb\n")).toBe("a\nb");
    const long = [...Array.from({ length: 300 }, (_, i) => `ok ${i}`), "src/x.ts(3,1): error TS2339: nope", ...Array.from({ length: 300 }, (_, i) => `ok more ${i}`), "1 failed"].join("\n");
    const cut = failureExcerpt(long);
    expect(cut).toContain("error TS2339: nope");
    expect(cut).toContain("1 failed");
    expect(cut).not.toContain("ok 5\n");
    expect(cut.split("\n").length).toBeLessThanOrEqual(80);
  });
});
