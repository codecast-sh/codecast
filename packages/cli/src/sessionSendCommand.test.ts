import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { sessionIdFromEnv } from "./sessionIdentity.js";
import { printSendStatus, registerSessionSendCommand } from "./sessionSendCommand.js";

function command(env: NodeJS.ProcessEnv = {}, response: Record<string, unknown> = {}, failure?: Error) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const output: string[] = [];
  const program = new Command();
  registerSessionSendCommand(program, {
    currentSession: () => sessionIdFromEnv(env),
    post: async (path, body) => {
      requests.push({ path, body });
      if (failure) throw failure;
      return { from_short_id: "jx7abcd", to_short_id: "jx7c6zk", ...response };
    },
    print: text => output.push(text),
  });
  return {
    requests,
    output,
    run: (...args: string[]) => program.parseAsync(["send", "jx7c6zk", ...args], { from: "user" }),
  };
}

describe("session send command", () => {
  test("a target with no live daemon reads as queued, never as sent", async () => {
    const cli = command({ CODEX_THREAD_ID: "t" }, { target_live: false, cross_user: true });
    await cli.run("are you there?");
    const out = cli.output.join("\n");
    expect(out).toContain("queued for");
    expect(out).toContain("arrives when its machine comes back online");
    expect(out).not.toContain("sent to");
  });

  test("native Codex identity reaches the request without rewriting the message", async () => {
    const cli = command({ CODEX_THREAD_ID: "native-thread-uuid" });
    const body = 'First line\n\nLiteral $() and `code`.\nThe user authorized this review.';
    await cli.run(body);
    expect(cli.requests).toEqual([{
      path: "/cli/messages/send",
      body: { to: "jx7c6zk", from: "native-thread-uuid", body, wake: false },
    }]);
    expect(cli.output.join("\n")).not.toContain("without resolving");
  });

  test("a detached shell without an identity fails before posting", async () => {
    const cli = command();
    await expect(cli.run("routine update")).rejects.toThrow("Nothing was sent. Pass --from");
    expect(cli.requests).toEqual([]);
    expect(cli.output).toEqual([]);
  });

  test("a send asks the server to hold a stale target unless --wake is passed", async () => {
    const plain = command({ CODEX_THREAD_ID: "t" });
    await plain.run("update");
    expect(plain.requests[0].body.wake).toBe(false);
    const woken = command({ CODEX_THREAD_ID: "t" });
    await woken.run("update", "--wake");
    expect(woken.requests[0].body.wake).toBe(true);
    const raw = command({ CODEX_THREAD_ID: "t" });
    await raw.run("/model opus", "--raw");
    expect("wake" in raw.requests[0].body).toBe(false);
  });

  test("a detached script can carry an explicit sender", async () => {
    const cli = command();
    await cli.run("update", "--from", "jx7abcd");
    expect(cli.requests[0].body.from).toBe("jx7abcd");
  });

  test("explicit sender overrides inherited identity", async () => {
    const cli = command({ CODEX_THREAD_ID: "inherited-thread" });
    await cli.run("update", "--from", " jx7abcd ");
    expect(cli.requests[0].body.from).toBe("jx7abcd");
  });

  test.each([false, true])("an empty explicit sender is rejected (raw=%s)", async (raw) => {
    const cli = command({ CODEX_THREAD_ID: "inherited-thread" });
    await expect(cli.run("update", "--from", " ", ...(raw ? ["--raw"] : []))).rejects.toThrow("Nothing was sent");
    expect(cli.requests).toEqual([]);
  });

  test("an empty body never posts", async () => {
    const cli = command({ CODEX_THREAD_ID: "native-thread" });
    await expect(cli.run(" \n ")).rejects.toThrow("Message text is empty");
    expect(cli.requests).toEqual([]);
  });

  test("raw slash commands keep their existing unattributed path", async () => {
    const cli = command({}, { from_short_id: "unknown" });
    await cli.run("/model opus", "--raw");
    expect(cli.requests[0].body).toEqual({ to: "jx7c6zk", body: "/model opus", from: undefined, raw: true });
    expect(cli.output).toHaveLength(1);
  });

  test("raw refuses a report body so it cannot land as the human's words", async () => {
    const cli = command({ CODEX_THREAD_ID: "t" });
    await expect(cli.run("Backend B (ct-51438) review fixes: all five of mine fixed.", "--raw")).rejects.toThrow(
      /only for slash commands/,
    );
    expect(cli.requests).toEqual([]);
  });

  test("an older server's unresolved result is reported as already queued", async () => {
    const cli = command({ CODEX_THREAD_ID: "native-thread" }, { from_short_id: "unknown", target_live: false });
    await cli.run("update");
    expect(cli.requests).toHaveLength(1);
    expect(cli.output.join("\n")).toContain("server queued this message without resolving its sender");
    expect(cli.output.join("\n")).toContain("when its machine comes back online");
  });
});

describe("a refused send", () => {
  test("keeps the body and prints the one command that sends it", async () => {
    const held: Array<{ target: string; body: string }> = [];
    const program = new Command();
    registerSessionSendCommand(program, {
      currentSession: () => "jx7abcd",
      post: async () => { throw new Error("Not sent. jx7c6zk was killed. Sending would restart it."); },
      print: () => {},
      hold: (target, body) => { held.push({ target, body }); return "/tmp/held/jx7c6zk-1.txt"; },
    });
    const body = "a long\nmulti-line brief";
    await expect(program.parseAsync(["send", "jx7c6zk", body], { from: "user" }))
      .rejects.toThrow("cast send --wake jx7c6zk - < /tmp/held/jx7c6zk-1.txt");
    expect(held).toEqual([{ target: "jx7c6zk", body }]);
  });

  test("the printed resend keeps --done", async () => {
    const program = new Command();
    registerSessionSendCommand(program, {
      currentSession: () => "jx7abcd",
      post: async () => { throw new Error("Not sent. jx7c6zk was killed."); },
      print: () => {},
      hold: () => "/tmp/held/jx7c6zk-2.txt",
    });
    await expect(program.parseAsync(["send", "jx7c6zk", "--done", "merged"], { from: "user" }))
      .rejects.toThrow("cast send --wake --done jx7c6zk - < /tmp/held/jx7c6zk-2.txt");
  });

  test("a role paused by a person's take-over keeps the body and offers no --wake", async () => {
    const held: string[] = [];
    const program = new Command();
    registerSessionSendCommand(program, {
      currentSession: () => "jx7abcd",
      post: async () => { throw new Error("Not sent. @growth is paused on jx7c6zk: Jason is working in it. If Jason needs to hear this, ask them in your own thread."); },
      print: () => {},
      hold: (_target, body) => { held.push(body); return "/tmp/held/jx7c6zk-3.txt"; },
    });
    const err = await program.parseAsync(["send", "jx7c6zk", "status?"], { from: "user" }).then(() => null, (e) => e as Error);
    expect(err?.message).toContain("Your message is kept in /tmp/held/jx7c6zk-3.txt");
    expect(err?.message).not.toContain("--wake");
    expect(held).toEqual(["status?"]);
  });

  test("a person's own session its task filed under the role keeps the body the same way", async () => {
    const program = new Command();
    registerSessionSendCommand(program, {
      currentSession: () => "jx7abcd",
      post: async () => { throw new Error("Not sent. @growth is paused on jx7c6zk: it is Jason's own session, filed under @growth by its task, and they are working in it. Ask them in your own thread."); },
      print: () => {},
      hold: () => "/tmp/held/jx7c6zk-4.txt",
    });
    const err = await program.parseAsync(["send", "jx7c6zk", "status?"], { from: "user" }).then(() => null, (e) => e as Error);
    expect(err?.message).toContain("Your message is kept in /tmp/held/jx7c6zk-4.txt");
    expect(err?.message).not.toContain("--wake");
  });

  test("other failures pass through and keep nothing", async () => {
    let kept = false;
    const program = new Command();
    registerSessionSendCommand(program, {
      currentSession: () => "jx7abcd",
      post: async () => { throw new Error("Session not found"); },
      print: () => {},
      hold: () => { kept = true; return ""; },
    });
    await expect(program.parseAsync(["send", "jx7c6zk", "hi"], { from: "user" })).rejects.toThrow(/^Session not found$/);
    expect(kept).toBe(false);
  });
});

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("the receipt says when the message arrives", () => {
  const cases: Array<[string, string]> = [
    ["now", "sent to jx7c6zk from jx7abcd, arrives now"],
    ["next_tool_call", "sent to jx7c6zk from jx7abcd, arrives at its next tool call"],
    ["end_of_turn", "sent to jx7c6zk from jx7abcd, arrives when its current turn ends"],
    ["after_prompt", "sent to jx7c6zk from jx7abcd, arrives once someone answers the prompt open in it"],
    ["after_start", "sent to jx7c6zk from jx7abcd, arrives once it finishes starting"],
    ["on_resume", "sent to jx7c6zk from jx7abcd, arrives once its machine resumes it"],
    ["when_online", "queued for jx7c6zk from jx7abcd, arrives when its machine comes back online. You'll be told if it is still waiting after a few minutes."],
    ["held", "queued for jx7c6zk from jx7abcd, arrives only after a person clears its safety stop."],
    ["never", "queued for jx7c6zk from jx7abcd, arrives never: a run's log has no agent, so it stays on the run's record."],
  ];
  for (const [arrives, line] of cases) {
    test(arrives, async () => {
      const cli = command({ CODEX_THREAD_ID: "t" }, { arrives, target_live: arrives !== "when_online" });
      await cli.run("update");
      expect(plain(cli.output).slice(2)).toBe(line);
    });
  }

  test("an older server without arrives still reads as sent", async () => {
    const cli = command({ CODEX_THREAD_ID: "t" }, { target_live: true });
    await cli.run("update");
    expect(plain(cli.output)).toBe("✓ sent to jx7c6zk from jx7abcd");
  });
});

describe("--done and --fyi", () => {
  test("--done sends intent done", async () => {
    const cli = command({ CODEX_THREAD_ID: "t" });
    await cli.run("--done", "merged; nothing left for you");
    expect(cli.requests[0].body).toMatchObject({ intent: "done", body: "merged; nothing left for you" });
  });

  test("--fyi sends intent inform", async () => {
    const cli = command({ CODEX_THREAD_ID: "t" });
    await cli.run("--fyi", "main is red");
    expect(cli.requests[0].body).toMatchObject({ intent: "inform" });
  });

  test("a plain send carries no intent", async () => {
    const cli = command({ CODEX_THREAD_ID: "t" });
    await cli.run("question?");
    expect(cli.requests[0].body).not.toHaveProperty("intent");
  });

  test("both flags, or either with --raw, are refused before posting", async () => {
    const both = command({ CODEX_THREAD_ID: "t" });
    await expect(both.run("--done", "--fyi", "x")).rejects.toThrow("Pick one of --done and --fyi");
    const raw = command({ CODEX_THREAD_ID: "t" });
    await expect(raw.run("--raw", "--done", "/model opus")).rejects.toThrow("drop --raw");
    expect([...both.requests, ...raw.requests]).toHaveLength(0);
  });
});

describe("--status", () => {
  test("posts the status query from the current session", async () => {
    const cli = command({ CODEX_THREAD_ID: "t" }, { sends: [] });
    await cli.run("--status");
    expect(cli.requests).toEqual([{ path: "/cli/messages/status", body: { to: "jx7c6zk", from: "t" } }]);
    expect(plain(cli.output)).toBe("No sends from this session to jx7c6zk.");
  });

  test("refuses message text and send flags", async () => {
    const cases: Array<[string[], string]> = [
      [["--status", "hello"], "--status takes no message text"],
      [["--status", "--done"], "--status shows past sends; it does not take --done"],
      [["--status", "--wake"], "it does not take --wake"],
    ];
    for (const [args, message] of cases) {
      const cli = command({ CODEX_THREAD_ID: "t" });
      await expect(cli.run(...args)).rejects.toThrow(message);
      expect(cli.requests).toHaveLength(0);
    }
  });

  test("one line per send: state, times, intent, preview", () => {
    const now = 1_000_000_000;
    const out: string[] = [];
    printSendStatus({
      to_short_id: "jx7c6zk",
      sends: [
        { created_at: now - 30_000, status: "pending", intent: "done", preview: "nothing left for you" },
        { created_at: now - 600_000, status: "delivered", typed_in_at: now - 590_000, delivered_at: now - 530_000, intent: "request", preview: "can you take auth?" },
        { created_at: now - 7_200_000, status: "cancelled", intent: "inform", preview: "fyi" },
        { created_at: now - 60_000, status: "injected", intent: "request", preview: "claimed, not pasted" },
        { created_at: now - 60_000, status: "injected", typed_in_at: now - 50_000, intent: "request", preview: "pasted" },
        { created_at: now - 60_000, status: "undeliverable", reason: "terminal waiting for a human answer", intent: "request", preview: "x" },
      ],
    }, (t) => out.push(t), now);
    expect(plain(out).split("\n")).toEqual([
      "Your last 6 sends to jx7c6zk, newest first:",
      "  queued        sent 30s ago [done]  nothing left for you",
      "  delivered     sent 10m ago, typed in 9m ago, delivered 8m ago  can you take auth?",
      "  cancelled     sent 2h ago [fyi]  fyi",
      "  sending       sent 1m ago  claimed, not pasted",
      "  typed in      sent 1m ago, typed in 50s ago  pasted",
      "  undeliverable sent 1m ago (terminal waiting for a human answer)  x",
    ]);
  });
});

describe("a refused send", () => {
  test("keeps the body and prints the one command that sends it", async () => {
    const held: Array<{ target: string; body: string }> = [];
    const program = new Command();
    registerSessionSendCommand(program, {
      currentSession: () => "jx7abcd",
      post: async () => { throw new Error("Not sent. jx7c6zk was killed. Sending would restart it."); },
      print: () => {},
      hold: (target, body) => { held.push({ target, body }); return "/tmp/held/jx7c6zk-1.txt"; },
    });
    const body = "a long\nmulti-line brief";
    await expect(program.parseAsync(["send", "jx7c6zk", body], { from: "user" }))
      .rejects.toThrow("cast send --wake jx7c6zk - < /tmp/held/jx7c6zk-1.txt");
    expect(held).toEqual([{ target: "jx7c6zk", body }]);
  });

  test("other failures pass through and keep nothing", async () => {
    let kept = false;
    const program = new Command();
    registerSessionSendCommand(program, {
      currentSession: () => "jx7abcd",
      post: async () => { throw new Error("Session not found"); },
      print: () => {},
      hold: () => { kept = true; return ""; },
    });
    await expect(program.parseAsync(["send", "jx7c6zk", "hi"], { from: "user" })).rejects.toThrow(/^Session not found$/);
    expect(kept).toBe(false);
  });
});

describe("a refused send", () => {
  test("keeps the body and prints the one command that sends it", async () => {
    const held: Array<{ target: string; body: string }> = [];
    const program = new Command();
    registerSessionSendCommand(program, {
      currentSession: () => "jx7abcd",
      post: async () => { throw new Error("Not sent. jx7c6zk was killed. Sending would restart it."); },
      print: () => {},
      hold: (target, body) => { held.push({ target, body }); return "/tmp/held/jx7c6zk-1.txt"; },
    });
    const body = "a long\nmulti-line brief";
    await expect(program.parseAsync(["send", "jx7c6zk", body], { from: "user" }))
      .rejects.toThrow("cast send --wake jx7c6zk - < /tmp/held/jx7c6zk-1.txt");
    expect(held).toEqual([{ target: "jx7c6zk", body }]);
  });

  test("other failures pass through and keep nothing", async () => {
    let kept = false;
    const program = new Command();
    registerSessionSendCommand(program, {
      currentSession: () => "jx7abcd",
      post: async () => { throw new Error("Session not found"); },
      print: () => {},
      hold: () => { kept = true; return ""; },
    });
    await expect(program.parseAsync(["send", "jx7c6zk", "hi"], { from: "user" })).rejects.toThrow(/^Session not found$/);
    expect(kept).toBe(false);
  });
});

describe("a refused send", () => {
  test("keeps the body and prints the one command that sends it", async () => {
    const held: Array<{ target: string; body: string }> = [];
    const program = new Command();
    registerSessionSendCommand(program, {
      currentSession: () => "jx7abcd",
      post: async () => { throw new Error("Not sent. jx7c6zk was killed. Sending would restart it."); },
      print: () => {},
      hold: (target, body) => { held.push({ target, body }); return "/tmp/held/jx7c6zk-1.txt"; },
    });
    const body = "a long\nmulti-line brief";
    await expect(program.parseAsync(["send", "jx7c6zk", body], { from: "user" }))
      .rejects.toThrow("cast send --wake jx7c6zk - < /tmp/held/jx7c6zk-1.txt");
    expect(held).toEqual([{ target: "jx7c6zk", body }]);
  });

  test("other failures pass through and keep nothing", async () => {
    let kept = false;
    const program = new Command();
    registerSessionSendCommand(program, {
      currentSession: () => "jx7abcd",
      post: async () => { throw new Error("Session not found"); },
      print: () => {},
      hold: () => { kept = true; return ""; },
    });
    await expect(program.parseAsync(["send", "jx7c6zk", "hi"], { from: "user" })).rejects.toThrow(/^Session not found$/);
    expect(kept).toBe(false);
  });
});
