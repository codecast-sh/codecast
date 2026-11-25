import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPLY_STREAM_MAX_CHARS, type ReplyStreamPushResult } from "@codecast/shared/contracts";
import {
  REPLY_STREAM_SETTINGS_FILE,
  ReplyStreamTracker,
  ensureReplyStreamSettings,
  parseMessageDisplay,
  replyStreamLaunchFragment,
  replyStreamSettingsJson,
  type ReplyStreamPushArgs,
} from "./replyStream.js";
import { shellEscapeForSh } from "./supervision.js";

/** Lets the tracker's promise chains run. Not a wait: it yields one macrotask. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type Answer = ReplyStreamPushResult | null | Error;

function rig(opts: {
  on?: () => boolean;
  conversationFor?: (sessionId: string) => string | undefined;
  redact?: (text: string) => string;
  throwOnce?: boolean;
} = {}) {
  let throwNext = opts.throwOnce ?? false;
  let now = 1_000_000;
  let nextTimer = 0;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  const pushes: Array<{ conversationId: string; args: ReplyStreamPushArgs; settle: (a: Answer) => void; settled: boolean }> = [];
  const logs: string[] = [];
  const tracker = new ReplyStreamTracker({
    now: () => now,
    on: opts.on ?? (() => true),
    conversationFor: opts.conversationFor ?? ((s) => (s === "S" ? "C" : undefined)),
    redact: opts.redact ?? ((t) => t),
    push: (conversationId, args) => {
      if (throwNext) {
        throwNext = false;
        throw new Error("boom");
      }
      return new Promise((resolve, reject) => {
        const entry = {
          conversationId,
          args: structuredClone(args),
          settled: false,
          settle: (a: Answer) => {
            entry.settled = true;
            if (a instanceof Error) reject(a);
            else resolve(a);
          },
        };
        pushes.push(entry);
      });
    },
    log: (m) => logs.push(m),
    setTimer: (fn, ms) => {
      const t = { id: nextTimer++, at: now + ms, fn };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return {
    tracker,
    pushes,
    logs,
    texts: () => pushes.map((p) => p.args.text),
    batch: (index: number, delta: string, final = false, message_id = "M1", session_id = "S") =>
      tracker.receive({ session_id, message_id, index, final, delta }),
    /** Answer the oldest unanswered push. */
    answer: async (a: Answer) => {
      const p = pushes.find((x) => !x.settled);
      if (!p) throw new Error("no push in flight");
      p.settle(a);
      await flush();
    },
    advance: async (ms: number) => {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
        await flush();
      }
      now = end;
    },
    get now() {
      return now;
    },
  };
}

const WRITTEN: ReplyStreamPushResult = { state: "written" };

describe("parseMessageDisplay", () => {
  const real = {
    cwd: "/Users/me/code/app",
    delta: "First paragraph.\n",
    final: false,
    hook_event_name: "MessageDisplay",
    index: 0,
    message_id: "0d6f1c1e-7a52-4c1a-9b8e-2f6c7d1a0b11",
    prompt_id: "p-1",
    scratchpad_dir: "/private/tmp/x",
    session_id: "11111111-2222-3333-4444-555555555555",
    transcript_path: "/Users/me/.claude/projects/app/11111111-2222-3333-4444-555555555555.jsonl",
    turn_id: "t-1",
  };

  test("a real payload parses to the fields the tracker uses", () => {
    expect(parseMessageDisplay(JSON.stringify(real))).toEqual({
      session_id: real.session_id,
      message_id: real.message_id,
      index: 0,
      final: false,
      delta: "First paragraph.\n",
    });
  });

  test("anything else is null", () => {
    expect(parseMessageDisplay(JSON.stringify({ ...real, hook_event_name: "Stop" }))).toBeNull();
    expect(parseMessageDisplay("not json")).toBeNull();
    expect(parseMessageDisplay("null")).toBeNull();
    for (const key of ["session_id", "message_id", "index", "final", "delta"]) {
      const { [key as keyof typeof real]: _, ...rest } = real;
      expect(parseMessageDisplay(JSON.stringify(rest))).toBeNull();
    }
    for (const index of [-1, 1.5, "1", null]) expect(parseMessageDisplay(JSON.stringify({ ...real, index }))).toBeNull();
    expect(parseMessageDisplay(JSON.stringify({ ...real, final: "true" }))).toBeNull();
    expect(parseMessageDisplay(JSON.stringify({ ...real, delta: 3 }))).toBeNull();
    expect(parseMessageDisplay(JSON.stringify({ ...real, message_id: "" }))).toBeNull();
  });
});

describe("joining a message's batches", () => {
  test("batches 0, 2, 1 out of order join in index order", async () => {
    const r = rig();
    r.batch(0, "A\n");
    r.batch(2, "C\n");
    r.batch(1, "B\n");
    expect(r.texts()).toEqual(["A\n"]);
    await r.answer(WRITTEN);
    await r.advance(300);
    expect(r.texts()).toEqual(["A\n", "A\nB\nC\n"]);
  });

  test("a gap holds the text back until it fills", async () => {
    const r = rig();
    r.batch(0, "A\n");
    await r.answer(WRITTEN);
    await r.advance(1000);
    r.batch(2, "C\n");
    await r.advance(1000);
    expect(r.texts()).toEqual(["A\n"]);
    r.batch(1, "B\n");
    expect(r.texts()).toEqual(["A\n", "A\nB\nC\n"]);
  });

  test("a message with no index 0 never pushes", async () => {
    const r = rig();
    r.batch(1, "B\n");
    r.batch(2, "C\n");
    r.batch(3, "D", true);
    await r.advance(5000);
    expect(r.pushes).toEqual([]);
  });

  test("a message that is one final batch never pushes", async () => {
    const r = rig();
    r.batch(0, "Short answer.", true);
    await r.advance(5000);
    expect(r.pushes).toEqual([]);
  });

  test("a multi-batch message pushes growing text, seq rising, started_at fixed, and its final text", async () => {
    const r = rig();
    const started = r.now;
    r.batch(0, "One.\n");
    await r.answer(WRITTEN);
    await r.advance(400);
    r.batch(1, "Two.\n");
    await r.answer(WRITTEN);
    await r.advance(400);
    r.batch(2, "Three.", true);
    await r.answer(WRITTEN);
    expect(r.pushes.map((p) => p.args)).toEqual([
      { message_id: "M1", seq: 1, started_at: started, text: "One.\n" },
      { message_id: "M1", seq: 2, started_at: started, text: "One.\nTwo.\n" },
      { message_id: "M1", seq: 3, started_at: started, text: "One.\nTwo.\nThree." },
    ]);
    expect(r.pushes.every((p) => p.conversationId === "C")).toBe(true);
  });

  test("a new message id replaces the current one; the old id's late batches are dropped", async () => {
    const r = rig();
    r.batch(0, "Abandoned one.\n", false, "OLD");
    await r.answer(WRITTEN);
    await r.advance(400);
    r.batch(0, "Retry one.\n", false, "NEW");
    await r.answer(WRITTEN);
    await r.advance(400);
    // The abandoned stream's final, hours later.
    r.batch(1, "Abandoned two.", true, "OLD");
    r.batch(0, "Abandoned again.\n", false, "OLD");
    await r.advance(5000);
    r.batch(1, "Retry two.\n", false, "NEW");
    await r.answer(WRITTEN);
    expect(r.pushes.map((p) => [p.args.message_id, p.args.seq, p.args.text])).toEqual([
      ["OLD", 1, "Abandoned one.\n"],
      ["NEW", 1, "Retry one.\n"],
      ["NEW", 2, "Retry one.\nRetry two.\n"],
    ]);
  });
});

describe("coalescing", () => {
  test("one push in flight, 300 ms between starts", async () => {
    const r = rig();
    r.batch(0, "a\n");
    r.batch(1, "b\n");
    r.batch(2, "c\n");
    expect(r.pushes.length).toBe(1);
    await r.answer(WRITTEN);
    expect(r.pushes.length).toBe(1);
    await r.advance(299);
    expect(r.pushes.length).toBe(1);
    await r.advance(1);
    expect(r.texts()).toEqual(["a\n", "a\nb\nc\n"]);
  });

  test("the final text goes the moment the push ahead of it returns", async () => {
    const r = rig();
    r.batch(0, "a\n");
    r.batch(1, "b", true);
    expect(r.pushes.length).toBe(1);
    await r.answer(WRITTEN);
    expect(r.texts()).toEqual(["a\n", "a\nb"]);
  });

  test("identical text is not sent again, empty text never", async () => {
    const r = rig({ redact: (t) => t.replace(/IGNORED/g, "") });
    r.batch(0, "");
    expect(r.pushes).toEqual([]);
    r.batch(1, "a\n");
    await r.answer(WRITTEN);
    await r.advance(400);
    r.batch(2, "IGNORED");
    await r.advance(400);
    r.batch(3, "", true);
    await r.advance(400);
    expect(r.texts()).toEqual(["a\n"]);
  });
});

describe("answers", () => {
  test("unwatched pauses 3 s, then the next push carries the whole text so far", async () => {
    const r = rig();
    r.batch(0, "a\n");
    await r.answer({ state: "unwatched" });
    r.batch(1, "b\n");
    await r.advance(2000);
    r.batch(2, "c\n");
    await r.advance(999);
    expect(r.pushes.length).toBe(1);
    await r.advance(1);
    r.batch(3, "d\n");
    expect(r.texts()).toEqual(["a\n", "a\nb\nc\nd\n"]);
  });

  test("text that was not written is sent again after the pause", async () => {
    const r = rig();
    r.batch(0, "a\n");
    r.batch(1, "b\n");
    await r.answer(WRITTEN);
    await r.advance(300);
    await r.answer({ state: "unwatched" });
    await r.advance(3000);
    r.batch(2, "");
    expect(r.texts()).toEqual(["a\n", "a\nb\n", "a\nb\n"]);
  });

  test("off pauses 10 minutes", async () => {
    const r = rig();
    r.batch(0, "a\n");
    await r.answer({ state: "off" });
    await r.advance(9 * 60_000);
    r.batch(1, "b\n");
    await r.advance(60_000 - 1);
    r.batch(2, "c\n");
    expect(r.pushes.length).toBe(1);
    await r.advance(1);
    r.batch(3, "d\n");
    expect(r.texts()).toEqual(["a\n", "a\nb\nc\nd\n"]);
    expect(r.logs.some((l) => l.includes("off"))).toBe(true);
  });

  for (const [name, answer] of [["null", null], ["a rejected push", new Error("network")]] as const) {
    test(`${name} behaves as unwatched and does not wedge the tracker`, async () => {
      const r = rig();
      r.batch(0, "a\n");
      await r.answer(answer);
      r.batch(1, "b\n");
      await r.advance(2999);
      r.batch(2, "c\n");
      expect(r.pushes.length).toBe(1);
      await r.advance(1);
      r.batch(3, "d\n");
      expect(r.texts()).toEqual(["a\n", "a\nb\nc\nd\n"]);
      await r.answer(WRITTEN);
      await r.advance(300);
      r.batch(4, "e", true);
      expect(r.texts().at(-1)).toBe("a\nb\nc\nd\ne");
    });
  }

  test("a push that throws before returning a promise does not escape or wedge", async () => {
    const r = rig({ throwOnce: true });
    expect(() => r.batch(0, "a\n")).not.toThrow();
    await flush();
    expect(r.logs.some((l) => l.includes("boom"))).toBe(true);
    await r.advance(3000);
    r.batch(1, "b\n");
    expect(r.texts()).toEqual(["a\nb\n"]);
  });
});

describe("redaction and the cap", () => {
  test("the pushed text is redacted", async () => {
    const r = rig({ redact: (t) => t.replace(/sk-[a-z0-9]+/g, "[REDACTED]") });
    r.batch(0, "key sk-abc123 here\n");
    expect(r.texts()).toEqual(["key [REDACTED] here\n"]);
  });

  test("the cap applies after redaction", async () => {
    const r = rig({ redact: (t) => t.replace(/k/g, "kk") });
    r.batch(0, "k".repeat(REPLY_STREAM_MAX_CHARS / 2 + 10));
    expect(r.texts()[0]!.length).toBe(REPLY_STREAM_MAX_CHARS);
  });
});

describe("what is tracked", () => {
  test("no conversation for the session: nothing", async () => {
    const r = rig({ conversationFor: () => undefined });
    r.batch(0, "a\n");
    r.batch(1, "b", true);
    expect(r.pushes).toEqual([]);
    expect(r.tracker.size).toBe(0);
  });

  test("the feature off: nothing", async () => {
    const r = rig({ on: () => false });
    r.batch(0, "a\n");
    r.batch(1, "b", true);
    expect(r.pushes).toEqual([]);
    expect(r.tracker.size).toBe(0);
  });

  test("a conversation idle for 15 minutes is forgotten", async () => {
    const r = rig({ conversationFor: (s) => `conv-${s}` });
    r.batch(0, "a\n", false, "M1", "S1");
    await r.answer(WRITTEN);
    await r.advance(15 * 60_000 + 1);
    r.batch(0, "x\n", false, "M2", "S2");
    expect(r.tracker.size).toBe(1);
  });

  test("at most 64 conversations at once", () => {
    const r = rig({ conversationFor: (s) => `conv-${s}` });
    for (let i = 0; i < 70; i++) r.batch(0, "", false, "M", `S${i}`);
    expect(r.tracker.size).toBe(64);
  });
});

describe("the settings file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reply-stream-settings-"));
  afterAll(() => {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const TOKEN = "ab".repeat(32);
  const file = path.join(dir, REPLY_STREAM_SETTINGS_FILE);

  test("its JSON is exactly the MessageDisplay http hook", () => {
    expect(replyStreamSettingsJson(41234, TOKEN)).toBe(
      `{"hooks":{"MessageDisplay":[{"hooks":[{"type":"http","url":"http://127.0.0.1:41234/hook/message-display","timeout":1,"headers":{"Authorization":"Bearer ${TOKEN}"}}]}]}}`,
    );
  });

  test("no file for a port that is not listening, or a token Claude Code would mangle", () => {
    expect(replyStreamSettingsJson(0, TOKEN)).toBeNull();
    expect(replyStreamSettingsJson(41234, "")).toBeNull();
    expect(replyStreamSettingsJson(41234, "ab$HOME")).toBeNull();
  });

  test("written at 0600, and an identical file is left untouched", async () => {
    expect(await ensureReplyStreamSettings(dir, 41234, TOKEN)).toBe(file);
    const first = fs.statSync(file);
    expect(first.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf-8")).toBe(replyStreamSettingsJson(41234, TOKEN)!);
    expect(await ensureReplyStreamSettings(dir, 41234, TOKEN)).toBe(file);
    const second = fs.statSync(file);
    expect(second.ino).toBe(first.ino);
    expect(second.mtimeMs).toBe(first.mtimeMs);
  });

  test("a missing, corrupted, stale or loosened file is repaired", async () => {
    const want = replyStreamSettingsJson(41234, TOKEN)!;
    fs.unlinkSync(file);
    expect(await ensureReplyStreamSettings(dir, 41234, TOKEN)).toBe(file);
    expect(fs.readFileSync(file, "utf-8")).toBe(want);
    fs.writeFileSync(file, "{");
    expect(await ensureReplyStreamSettings(dir, 41234, TOKEN)).toBe(file);
    expect(fs.readFileSync(file, "utf-8")).toBe(want);
    expect(await ensureReplyStreamSettings(dir, 50000, TOKEN)).toBe(file);
    expect(fs.readFileSync(file, "utf-8")).toBe(replyStreamSettingsJson(50000, TOKEN)!);
    fs.chmodSync(file, 0o644);
    expect(await ensureReplyStreamSettings(dir, 50000, TOKEN)).toBe(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual([REPLY_STREAM_SETTINGS_FILE]);
  });

  test("null when the directory is unwritable", async () => {
    fs.unlinkSync(file);
    fs.chmodSync(dir, 0o500);
    expect(await ensureReplyStreamSettings(dir, 41234, TOKEN)).toBeNull();
    fs.chmodSync(dir, 0o700);
  });
});

describe("replyStreamLaunchFragment", () => {
  const base = { on: true, agentType: "claude", configuredArgs: "", settingsPath: "/Users/me/.codecast/reply-stream-settings.json", escape: shellEscapeForSh };

  test("claude with the feature on gets --settings", () => {
    expect(replyStreamLaunchFragment({ ...base, log: () => {} })).toBe(" --settings '/Users/me/.codecast/reply-stream-settings.json'");
  });

  test("off, another agent, or no file: nothing", () => {
    expect(replyStreamLaunchFragment({ ...base, on: false, log: () => {} })).toBe("");
    expect(replyStreamLaunchFragment({ ...base, agentType: "codex", log: () => {} })).toBe("");
    expect(replyStreamLaunchFragment({ ...base, settingsPath: null, log: () => {} })).toBe("");
  });

  test("the person's own --settings wins, logged once", () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    expect(replyStreamLaunchFragment({ ...base, configuredArgs: "--model opus --settings ~/mine.json", log })).toBe("");
    expect(replyStreamLaunchFragment({ ...base, configuredArgs: "--settings=/x.json", log })).toBe("");
    expect(replyStreamLaunchFragment({ ...base, configuredArgs: "--settingsfoo", log })).toBe(" --settings '/Users/me/.codecast/reply-stream-settings.json'");
    expect(logs.length).toBe(1);
  });

  test("a path with spaces and quotes is shell-escaped", () => {
    expect(replyStreamLaunchFragment({ ...base, settingsPath: "/Users/O'Brien Smith/.codecast/reply-stream-settings.json", log: () => {} }))
      .toBe(` --settings '/Users/O'\\''Brien Smith/.codecast/reply-stream-settings.json'`);
  });
});
