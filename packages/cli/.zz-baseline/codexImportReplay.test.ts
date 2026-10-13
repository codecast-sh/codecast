import { describe, expect, test } from "bun:test";
import { parseCodexSessionFile } from "./parser.js";
import {
  type ImportAuthorityRejection,
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
const nonResponseCount = (items: Line[]) => items.length - responseCount(items);

const authorityOf = (text: string, id = IMPORT_ID) => {
  const result = readImportReplayAuthority(text, id);
  if (!result.ok) throw new Error(`expected authority, got hold: ${result.reason}`);
  return result.authority;
};

const runWhole = (authority: ReturnType<typeof authorityOf>, rollout: string) => {
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

  test("reads the whole import as authority, or holds: replaced, missing, malformed, truncated", () => {
    expect(authorityOf(importJsonl()).fingerprints.length).toBe(responseCount(importItems()));
    const hold = (text: string, reason: ImportAuthorityRejection, line?: number) => {
      const result = readImportReplayAuthority(text, IMPORT_ID);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.disposition).toBe("hold");
      expect(result.reason).toBe(reason);
      if (line !== undefined) expect(result.line).toBe(line);
    };
    // file under the import's name now holds a different session
    hold(importJsonl(importItems(), "some-other-id"), "wrong_session", 1);
    // nothing, or not a rollout at all
    hold("", "empty");
    hold("not json\n", "malformed_line", 1);
    hold(j(userMsg("x")) + "\n", "no_session_meta", 1);
    // a malformed line anywhere in the body rejects the whole file: no partial authority
    const good = importJsonl();
    hold(good + "{bad-final-response\n", "malformed_line", importItems().length + 2);
    hold(good.replace(j(userMsg("retry")), "{bad-middle"), "malformed_line");
    // a final line cut mid-write (no trailing newline) is a truncated file
    hold(good.slice(0, -1), "truncated_tail");
    hold(good + "{\"type\":\"response_item\",\"payload\":\"", "truncated_tail");
    // a line type the rollout format does not have
    hold(good + j({ type: "mystery", payload: {} }) + "\n", "unknown_line_type");
    // a response_item without an object payload
    hold(good + j({ type: "response_item", payload: "x" }) + "\n", "malformed_line");
    expect(rolloutForkParentId(forkMeta())).toBe(IMPORT_ID);
    expect(rolloutForkParentId(j({ type: "session_meta", payload: { id: THREAD_ID } }))).toBeUndefined();
  });

  test("exact replay with a genuine tail already present at first sight: skips the copy, emits the tail", () => {
    const authority = authorityOf(importJsonl());
    const { cursor, skipped, emitted } = runWhole(authority, forkJsonl());
    expect(cursor.state).toBe("complete");
    expect(cursor.matched).toBe(responseCount(importItems()));
    // exactly the copied response items are skipped; nothing else ever is
    expect(skipped.length).toBe(responseCount(importItems()));
    expect(skipped.every((l) => JSON.parse(l).type === "response_item")).toBe(true);
    // emitted: the fork's session_meta, the copied event/turn lines (unproven, so kept), and the whole genuine tail in order
    const emittedParsed = emitted.map((l) => JSON.parse(l));
    expect(emittedParsed[0].type).toBe("session_meta");
    expect(emittedParsed.length).toBe(1 + nonResponseCount(importItems()) + genuineTail().length);
    expect(emittedParsed.filter((l) => l.type === "response_item").map((l) => [l.payload.type, l.payload.role])).toEqual(
      genuineTail().filter((l) => l.type === "response_item").map((l) => [(l.payload as Line).type, (l.payload as Line).role]),
    );
    // and what the parser makes of the emitted lines is exactly the genuine tail's messages
    const parsed = parseCodexSessionFile(emitted.join("\n") + "\n");
    expect(parsed.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("replay written across windows, boundary and a split line inside the middle window", () => {
    const authority = authorityOf(importJsonl());
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
    expect(r1.emitted.filter((l) => JSON.parse(l).type === "response_item")).toEqual([]);
    expect(cursor.state).toBe("replaying");
    const r2 = advanceReplayCursor(authority, cursor, r1.carry + w2);
    expect(cursor.state).toBe("complete");
    expect(r2.emitted.filter((l) => JSON.parse(l).type === "response_item")).toEqual([]);
    expect(r2.carry.length).toBeGreaterThan(0);
    const r3 = advanceReplayCursor(authority, cursor, r2.carry + w3);
    expect(r3.emitted.map((l) => [JSON.parse(l).type, JSON.parse(l).payload.role])).toEqual([
      ["response_item", "user"], ["event_msg", undefined], ["response_item", "assistant"],
    ]);
    expect(r3.carry).toBe("");
    expect(r1.skipped.length + r2.skipped.length + r3.skipped.length).toBe(responseCount(importItems()));
  });

  test("mismatch before the sequence is exhausted retains everything from that line on", () => {
    const authority = authorityOf(importJsonl());
    const items = importItems();
    // the fork's function_call differs from the import (call arguments changed)
    const tampered = items.map((l) => (l.type === "response_item" && (l.payload as Line).call_id === "call_1" && (l.payload as Line).type === "function_call" ? call("call_1", "ls -la") : l));
    const { cursor, skipped, emitted } = runWhole(authority, forkJsonl(tampered));
    expect(cursor.state).toBe("mismatch");
    const firstCall = items.findIndex((l) => (l.payload as Line).type === "function_call");
    expect(skipped.length).toBe(responseCount(items.slice(0, firstCall))); // proven copies before the divergence only
    // the divergent line, every later line, and the tail are all kept
    expect(emitted.length).toBe(1 + nonResponseCount(items.slice(0, firstCall)) + (items.length - firstCall) + genuineTail().length);
    // and no later line is ever skipped, even one that would match the import's next item
    expect(classifyRolloutLine(authority, cursor, j(forkLine(callOut("call_1", "a b c"))))).toBe("emit");
  });

  test("a malformed rollout line while matching ends skipping for good", () => {
    const authority = authorityOf(importJsonl());
    const cursor = createReplayCursor(authority.fingerprints.length);
    const firstItem = j(forkLine(importItems()[0]));
    expect(classifyRolloutLine(authority, cursor, firstItem)).toBe("skip");
    expect(classifyRolloutLine(authority, cursor, "{malformed")).toBe("emit");
    expect(cursor.state).toBe("mismatch");
    // the import's next item now arrives intact: it is emitted, not skipped
    expect(classifyRolloutLine(authority, cursor, j(forkLine(importItems()[1])))).toBe("emit");
    // same for a response_item whose payload is not an object
    const cursor2 = createReplayCursor(authority.fingerprints.length);
    expect(classifyRolloutLine(authority, cursor2, j({ type: "response_item", payload: "x" }))).toBe("emit");
    expect(cursor2.state).toBe("mismatch");
    expect(classifyRolloutLine(authority, cursor2, firstItem)).toBe("emit");
  });

  test("non-response lines are never skipped, including ones the parser turns into messages", () => {
    const authority = authorityOf(importJsonl());
    const cursor = createReplayCursor(authority.fingerprints.length);
    const errorLine = j({ timestamp: FORK_TS, type: "event_msg", payload: { type: "task_complete", turn_id: "t1", error: { message: "genuine error" } } });
    expect(parseCodexSessionFile(errorLine + "\n").length).toBe(1);
    expect(classifyRolloutLine(authority, cursor, errorLine)).toBe("emit");
    // a copied turn_context / event line during matching is emitted too, and matching goes on
    expect(classifyRolloutLine(authority, cursor, j(forkLine(turnContext())))).toBe("emit");
    expect(classifyRolloutLine(authority, cursor, j(forkLine(userEvent("x"))))).toBe("emit");
    expect(cursor.state).toBe("replaying");
    expect(classifyRolloutLine(authority, cursor, j(forkLine(importItems()[0])))).toBe("skip");
    // a later session_meta (fork lineage records) is emitted without ending matching
    expect(classifyRolloutLine(authority, cursor, forkMeta())).toBe("emit");
    expect(cursor.state).toBe("replaying");
  });

  test("no authority means nothing is skipped", () => {
    const authority = authorityOf(importJsonl());
    // a rollout forked from a different parent never reaches the cursor; the caller
    // resolves the parent first. A rollout whose parent has been replaced by a
    // same-id file with other content mismatches on its first item.
    const replaced = authorityOf(importJsonl([userMsg("something else")]));
    const { cursor, skipped, emitted } = runWhole(replaced, forkJsonl());
    expect(cursor.state).toBe("mismatch");
    expect(skipped.length).toBe(0);
    expect(emitted.length).toBe(1 + importItems().length + genuineTail().length);
    expect(authority.fingerprints).not.toEqual(replaced.fingerprints);
  });

  test("a genuine item identical to the import's last item is still emitted", () => {
    // the import ends with user "retry"; the first genuine turn is also "retry"
    const items = [...importItems().slice(0, -3), userMsg("retry")];
    const authority = authorityOf(importJsonl(items));
    const { cursor, emitted } = runWhole(authority, forkJsonl(items, genuineTail("retry")));
    expect(cursor.state).toBe("complete");
    const users = emitted.map((l) => JSON.parse(l)).filter((l) => l.type === "response_item" && l.payload.role === "user");
    expect(users.length).toBe(1);
    expect(users[0].payload.content[0].text).toBe("retry");
  });

  test("restart reconstruction from the rollout's own bytes equals the uninterrupted run", () => {
    const authority = authorityOf(importJsonl());
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
    const restItems = rest.emitted.map((l) => JSON.parse(l)).filter((l) => l.type === "response_item");
    expect(restItems.map((l) => l.payload.role)).toEqual(["user", "assistant"]);
    expect(rest.skipped.length + live.matched).toBe(responseCount(importItems()));
    // an empty import is complete from the start: nothing is ever skipped
    expect(createReplayCursor(0).state).toBe("complete");
  });
});
