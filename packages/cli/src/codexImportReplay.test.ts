import { describe, expect, test } from "bun:test";
import {
  advanceReplayCursor,
  classifyRolloutLine,
  createReplayCursor,
  readImportReplayAuthority,
  reconstructReplayCursor,
  responseItemFingerprint,
  rolloutForkParentId,
} from "./codexImportReplay.js";

// Synthetic import + fork pair shaped like the real 2026-09-04 files:
// the import is what generateCodexJsonl writes; the fork is what thread/fork
// wrote back (fresh payload.id on every response_item, fork-time timestamps,
// event_msg / turn_context re-shaped), followed by genuine turns.
const IMPORT_ID = "22b96cbf-2460-426a-8334-9cf6838815c1";
const THREAD_ID = "01a06e13-0e36-7202-b795-4719aa020cf4";
const IMPORT_TS = "2026-07-17T01:05:06.384Z";
const FORK_TS = "2026-09-04T20:19:07.984Z";

type Line = Record<string, unknown>;
const j = (o: Line) => JSON.stringify(o);

const userMsg = (text: string): Line => ({ timestamp: IMPORT_TS, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const assistantMsg = (text: string): Line => ({ timestamp: IMPORT_TS, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const call = (callId: string, cmd: string): Line => ({ timestamp: IMPORT_TS, type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: callId, arguments: JSON.stringify({ command: cmd }) } });
const callOut = (callId: string, out: string): Line => ({ timestamp: IMPORT_TS, type: "response_item", payload: { type: "function_call_output", call_id: callId, output: out } });
const userEvent = (text: string): Line => ({ timestamp: IMPORT_TS, type: "event_msg", payload: { type: "user_message", message: text, images: [], text_elements: [] } });
const turnContext = (): Line => ({ timestamp: IMPORT_TS, type: "turn_context", payload: { cwd: "/tmp/p", approval_policy: "never", sandbox_policy: { mode: "danger-full-access" }, model: "gpt-5" } });
const tokenCount = (): Line => ({ timestamp: IMPORT_TS, type: "event_msg", payload: { type: "token_count", info: { total: 12 }, rate_limits: null } });

const importItems = (): Line[] => [
  { timestamp: IMPORT_TS, type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>" }] } },
  userMsg("# Project context\nWorking directory: /tmp/p"),
  userMsg("try using the new kimi3 model in place of opus"),
  userEvent("try using the new kimi3 model in place of opus"),
  turnContext(),
  assistantMsg("I'll tackle this in four phases"),
  call("call_1", "ls"),
  tokenCount(),
  callOut("call_1", "a b c"),
  userMsg("retry"),
  userEvent("retry"),
  turnContext(),
  assistantMsg("retrying"),
];

const importJsonl = (items: Line[] = importItems(), id = IMPORT_ID): string =>
  [j({ timestamp: IMPORT_TS, type: "session_meta", payload: { id, timestamp: IMPORT_TS, cwd: "/tmp/p", originator: "codex_cli_rs", cli_version: "0.94.0" } }), ...items.map(j)].join("\n") + "\n";

let idCounter = 0;
const freshId = (prefix: string) => `${prefix}_01a06e13-0ded-7312-bddd-${String(++idCounter).padStart(12, "0")}`;

/** What thread/fork writes for one copied import line. */
const forkLine = (line: Line): Line => {
  const payload = line.payload as Line;
  if (line.type === "response_item") {
    const prefix = payload.type === "function_call" ? "fc" : payload.type === "function_call_output" ? "fco" : "msg";
    return { timestamp: FORK_TS, type: "response_item", payload: { id: freshId(prefix), ...payload } };
  }
  if (line.type === "turn_context") return { timestamp: FORK_TS, type: "turn_context", payload: { ...payload, turn_id: freshId("turn") } };
  return { timestamp: FORK_TS, type: "event_msg", payload: { ...payload, id: freshId("ev") } };
};

const forkMeta = (parentId = IMPORT_ID) =>
  j({ timestamp: FORK_TS, type: "session_meta", payload: { id: THREAD_ID, session_id: THREAD_ID, forked_from_id: parentId, timestamp: FORK_TS, cwd: "/tmp/p", originator: "codex_cli_rs" } });

/** A genuine turn as the app-server appends it after the copy. */
const genuineTail = (text = "now check the eval suite"): Line[] => [
  { timestamp: "2026-09-04T20:21:17.780Z", type: "turn_context", payload: { cwd: "/tmp/p", turn_id: freshId("turn") } },
  { timestamp: "2026-09-04T20:21:17.781Z", type: "response_item", payload: { id: freshId("msg"), type: "message", role: "user", content: [{ type: "input_text", text }] } },
  { timestamp: "2026-09-04T20:21:17.782Z", type: "event_msg", payload: { id: freshId("ev"), type: "user_message", message: text } },
  { timestamp: "2026-09-04T20:21:20.000Z", type: "response_item", payload: { id: freshId("msg"), type: "message", role: "assistant", content: [{ type: "output_text", text: "On it." }] } },
];

const forkJsonl = (items: Line[] = importItems(), tail: Line[] = genuineTail(), parentId = IMPORT_ID): string =>
  [forkMeta(parentId), ...items.map(forkLine).map(j), ...tail.map(j)].join("\n") + "\n";

const responseCount = (items: Line[]) => items.filter((l) => l.type === "response_item").length;

const runWhole = (authority: NonNullable<ReturnType<typeof readImportReplayAuthority>>, rollout: string) => {
  const cursor = createReplayCursor(authority.fingerprints.length);
  const result = advanceReplayCursor(authority, cursor, rollout);
  return { cursor, ...result };
};

describe("codex import replay boundary", () => {
  test("fingerprint ignores exactly the fork-added id; everything else is identity", () => {
    const base = { type: "function_call", name: "shell_command", call_id: "call_1", arguments: "{\"command\":\"ls\"}" };
    expect(responseItemFingerprint({ id: "fc_new", ...base })).toBe(responseItemFingerprint(base));
    expect(responseItemFingerprint({ ...base, call_id: "call_2" })).not.toBe(responseItemFingerprint(base));
    expect(responseItemFingerprint({ ...base, arguments: "{\"command\":\"ls -a\"}" })).not.toBe(responseItemFingerprint(base));
    // key order is not identity
    expect(responseItemFingerprint({ call_id: "call_1", type: "function_call", name: "shell_command", arguments: base.arguments })).toBe(responseItemFingerprint(base));
  });

  test("reads the import as authority and rejects a replaced or missing parent", () => {
    const authority = readImportReplayAuthority(importJsonl(), IMPORT_ID);
    expect(authority?.fingerprints.length).toBe(responseCount(importItems()));
    // file under the import's name now holds a different session
    expect(readImportReplayAuthority(importJsonl(importItems(), "some-other-id"), IMPORT_ID)).toBeNull();
    // not a rollout at all
    expect(readImportReplayAuthority("", IMPORT_ID)).toBeNull();
    expect(readImportReplayAuthority("not json\n", IMPORT_ID)).toBeNull();
    expect(rolloutForkParentId(forkMeta())).toBe(IMPORT_ID);
    expect(rolloutForkParentId(j({ type: "session_meta", payload: { id: THREAD_ID } }))).toBeUndefined();
  });

  test("exact replay with a genuine tail already present at first sight: skips the copy, emits the tail", () => {
    const authority = readImportReplayAuthority(importJsonl(), IMPORT_ID)!;
    const { cursor, skipped, emitted } = runWhole(authority, forkJsonl());
    expect(cursor.state).toBe("complete");
    expect(cursor.matched).toBe(responseCount(importItems()));
    // every copied line (response items AND the re-shaped event/turn lines) is skipped
    expect(skipped.length).toBe(importItems().length);
    // the fork's own session_meta plus the whole genuine tail are emitted, in order
    const emittedParsed = emitted.map((l) => JSON.parse(l));
    expect(emittedParsed[0].type).toBe("session_meta");
    expect(emittedParsed.slice(1).map((l) => [l.type, l.payload.type, l.payload.role])).toEqual(
      genuineTail().map((l) => [l.type, (l.payload as Line).type, (l.payload as Line).role]),
    );
  });

  test("replay written across windows, boundary and a split line inside the middle window", () => {
    const authority = readImportReplayAuthority(importJsonl(), IMPORT_ID)!;
    const rollout = forkJsonl();
    const lines = rollout.split("\n");
    // window 1: meta + first 5 copied lines; window 2: rest of the copy + first genuine line, cut mid-line; window 3: remainder
    const w1 = lines.slice(0, 6).join("\n") + "\n";
    const rest = lines.slice(6).join("\n") + "\n";
    const cut = rest.indexOf("now check the eval suite") + 5; // inside the genuine user message line
    const w2 = rest.slice(0, cut);
    const w3 = rest.slice(cut);

    const cursor = createReplayCursor(authority.fingerprints.length);
    const r1 = advanceReplayCursor(authority, cursor, w1);
    expect(r1.emitted.map((l) => JSON.parse(l).type)).toEqual(["session_meta"]);
    expect(cursor.state).toBe("replaying");
    const r2 = advanceReplayCursor(authority, cursor, r1.carry + w2);
    expect(cursor.state).toBe("complete");
    expect(r2.emitted.map((l) => JSON.parse(l).type)).toEqual(["turn_context"]);
    expect(r2.carry.length).toBeGreaterThan(0);
    const r3 = advanceReplayCursor(authority, cursor, r2.carry + w3);
    expect(r3.emitted.map((l) => [JSON.parse(l).type, JSON.parse(l).payload.role])).toEqual([
      ["response_item", "user"], ["event_msg", undefined], ["response_item", "assistant"],
    ]);
    expect(r3.carry).toBe("");
    expect(r1.skipped.length + r2.skipped.length + r3.skipped.length).toBe(importItems().length);
  });

  test("mismatch before the sequence is exhausted retains everything from that line on", () => {
    const authority = readImportReplayAuthority(importJsonl(), IMPORT_ID)!;
    const items = importItems();
    // the fork's 7th response item differs from the import (call arguments changed)
    const tampered = items.map((l) => (l.type === "response_item" && (l.payload as Line).call_id === "call_1" && (l.payload as Line).type === "function_call" ? call("call_1", "ls -la") : l));
    const { cursor, skipped, emitted } = runWhole(authority, forkJsonl(tampered));
    expect(cursor.state).toBe("mismatch");
    const firstCall = items.findIndex((l) => (l.payload as Line).type === "function_call");
    expect(skipped.length).toBe(firstCall); // everything up to the divergent item was a proven copy
    // the divergent line, every later copied line, and the tail are all kept
    expect(emitted.length).toBe(1 + (items.length - firstCall) + genuineTail().length);
    // and no later line is ever skipped, even one that would match the import's next item
    expect(classifyRolloutLine(authority, cursor, j(forkLine(callOut("call_1", "a b c"))))).toBe("emit");
  });

  test("no authority means nothing is skipped", () => {
    const authority = readImportReplayAuthority(importJsonl(), IMPORT_ID)!;
    // a rollout forked from a different parent never reaches the cursor; the caller
    // resolves the parent first. A rollout whose parent has been replaced by a
    // same-id file with other content mismatches on its first item.
    const replaced = readImportReplayAuthority(importJsonl([userMsg("something else")]), IMPORT_ID)!;
    const { cursor, skipped, emitted } = runWhole(replaced, forkJsonl());
    expect(cursor.state).toBe("mismatch");
    expect(skipped.length).toBe(0);
    expect(emitted.length).toBe(1 + importItems().length + genuineTail().length);
    expect(authority.fingerprints).not.toEqual(replaced.fingerprints);
  });

  test("a genuine item identical to the import's last item is still emitted", () => {
    // the import ends with user "retry"; the first genuine turn is also "retry"
    const items = [...importItems().slice(0, -3), userMsg("retry")];
    const authority = readImportReplayAuthority(importJsonl(items), IMPORT_ID)!;
    const { cursor, emitted } = runWhole(authority, forkJsonl(items, genuineTail("retry")));
    expect(cursor.state).toBe("complete");
    const users = emitted.map((l) => JSON.parse(l)).filter((l) => l.type === "response_item" && l.payload.role === "user");
    expect(users.length).toBe(1);
    expect(users[0].payload.content[0].text).toBe("retry");
  });

  test("restart reconstruction from the rollout's own bytes equals the uninterrupted run", () => {
    const authority = readImportReplayAuthority(importJsonl(), IMPORT_ID)!;
    const rollout = forkJsonl();
    const buf = Buffer.from(rollout, "utf8");
    // the daemon had consumed up to the end of the 9th line before restarting
    let consumed = 0;
    for (let n = 0; n < 9; n++) consumed = buf.indexOf("\n", consumed) + 1;
    const rebuilt = reconstructReplayCursor(authority, rollout, consumed);
    const live = createReplayCursor(authority.fingerprints.length);
    advanceReplayCursor(authority, live, rollout.slice(0, Buffer.from(buf.subarray(0, consumed)).toString("utf8").length));
    expect(rebuilt).toEqual(live);
    expect(rebuilt.state).toBe("replaying");
    // continuing from the rebuilt cursor yields exactly the genuine tail
    const rest = advanceReplayCursor(authority, rebuilt, buf.subarray(consumed).toString("utf8"));
    expect(rebuilt.state).toBe("complete");
    expect(rest.emitted.length).toBe(genuineTail().length);
    // an empty import is complete from the start: nothing is ever skipped
    expect(createReplayCursor(0).state).toBe("complete");
  });
});
