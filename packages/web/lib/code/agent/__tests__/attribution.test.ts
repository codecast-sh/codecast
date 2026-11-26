// Which session wrote a file: named only when the evidence points at exactly
// one working session.
import { describe, expect, it } from "bun:test";
import { ATTRIBUTION_WINDOW, PRESENCE_WINDOW, buildEditIndex, editIndexDigest, writerFor, writtenPaths, type MessageLike } from "../attribution";
import type { AgentSessionRow } from "../sessions";

const NOW = 1_000_000_000;
const row = (id: string, over: Partial<AgentSessionRow> = {}): AgentSessionRow => ({ _id: id, agent_type: "claude_code", updated_at: NOW, project_path: "/r/app", ...over });
const edit = (path: string, ago = 1000, name = "Edit"): MessageLike => ({ role: "assistant", timestamp: NOW - ago, tool_calls: [{ name, input: { file_path: path } }] });

function index(rows: AgentSessionRow[], msgs: Record<string, MessageLike[]>, opts: { working?: Set<string>; window?: typeof ATTRIBUTION_WINDOW } = {}) {
  return buildEditIndex({
    rows,
    isWorking: (r) => (opts.working ? opts.working.has(r._id) : true),
    messagesOf: (id) => msgs[id],
    now: NOW,
    window: opts.window ?? ATTRIBUTION_WINDOW,
  });
}

describe("writtenPaths", () => {
  it("reads path fields of write tools, multi-edits and patch headers", () => {
    expect(writtenPaths({ name: "Edit", input: { file_path: "/a.ts" } })).toEqual(["/a.ts"]);
    expect(writtenPaths({ name: "Write", input: JSON.stringify({ file_path: "/b.ts" }) })).toEqual(["/b.ts"]);
    expect(writtenPaths({ name: "MultiEdit", input: { edits: [{ file_path: "/c.ts" }] } })).toEqual(["/c.ts"]);
    expect(writtenPaths({ name: "apply_patch", input: "*** Begin Patch\n*** Update File: /d.ts\n@@\n*** Add File: /e.ts\n" }).sort()).toEqual(["/d.ts", "/e.ts"]);
  });

  it("ignores reads and relative paths", () => {
    expect(writtenPaths({ name: "Read", input: { file_path: "/a.ts" } })).toEqual([]);
    expect(writtenPaths({ name: "Edit", input: { file_path: "a.ts" } })).toEqual([]);
  });
});

describe("writerFor", () => {
  it("names the one working session whose tool call wrote the file", () => {
    const idx = index([row("s1"), row("s2")], { s1: [edit("/r/app/x.ts")], s2: [edit("/r/app/y.ts")] });
    expect(writerFor(idx, "/r/app/x.ts")).toBe("s1");
    expect(writerFor(idx, "/r/app/y.ts")).toBe("s2");
    expect(writerFor(idx, "/r/app/z.ts")).toBeNull();
  });

  it("two plausible writers name nobody", () => {
    const idx = index([row("s1"), row("s2")], { s1: [edit("/r/app/x.ts")], s2: [edit("/r/app/x.ts")] });
    expect(writerFor(idx, "/r/app/x.ts")).toBeNull();
  });

  it("a session that is not working now names nobody", () => {
    const idx = index([row("s1")], { s1: [edit("/r/app/x.ts")] }, { working: new Set() });
    expect(writerFor(idx, "/r/app/x.ts")).toBeNull();
  });

  it("calls older than the window, or past its count, do not count", () => {
    expect(writerFor(index([row("s1")], { s1: [edit("/r/app/x.ts", 10 * 60_000)] }), "/r/app/x.ts")).toBeNull();
    // Presence reads only the newest call.
    const msgs = { s1: [edit("/r/app/x.ts", 3000), edit("/r/app/y.ts", 1000)] };
    const presence = index([row("s1")], msgs, { window: PRESENCE_WINDOW });
    expect(writerFor(presence, "/r/app/x.ts")).toBeNull();
    expect(writerFor(presence, "/r/app/y.ts")).toBe("s1");
    expect(writerFor(index([row("s1")], msgs), "/r/app/x.ts")).toBe("s1");
  });

  it("a bare basename in an activity line counts only when the caller says it is unambiguous, inside the session's folder", () => {
    const rows = [row("s1", { activity: { text: "Editing `chat.ts`", tool: "Edit", at: NOW - 1000 } })];
    const idx = index(rows, {});
    const unique = () => true;
    expect(writerFor(idx, "/r/app/src/chat.ts", unique)).toBe("s1");
    expect(writerFor(idx, "/elsewhere/chat.ts", unique)).toBeNull();
    // Presence passes no `weak`: a basename never draws a dot.
    expect(writerFor(idx, "/r/app/src/chat.ts")).toBeNull();
  });

  it("a session in a home directory gives no name hint, but its absolute tool calls still count", () => {
    const rows = [row("s1", { project_path: "/Users/ada", activity: { text: "Editing chat.ts", tool: "Edit", at: NOW - 1000 } })];
    expect(writerFor(index(rows, {}), "/Users/ada/src/app/chat.ts", () => true)).toBeNull();
    expect(writerFor(index(rows, { s1: [edit("/Users/ada/src/app/chat.ts")] }), "/Users/ada/src/app/chat.ts")).toBe("s1");
  });

  it("two same-named files under one root: a bare name picks neither unless it is unambiguous", () => {
    const rows = [row("s1", { project_path: "/r", activity: { text: "Editing index.ts", tool: "Edit", at: NOW - 1000 } })];
    const idx = index(rows, {});
    const ambiguous = () => false;
    for (const p of ["/r/src/a/index.ts", "/r/src/b/index.ts", "/r/lib/c/index.ts"]) expect(writerFor(idx, p, ambiguous)).toBeNull();
  });

  it("a path in the activity line resolves against the session's project and names that file only", () => {
    const rows = [row("s1", { project_path: "/r", activity: { text: "Editing src/a/index.ts", tool: "Edit", at: NOW - 1000 } })];
    const idx = index(rows, {});
    expect(writerFor(idx, "/r/src/a/index.ts")).toBe("s1");
    expect(writerFor(idx, "/r/src/b/index.ts", () => true)).toBeNull();
  });

  it("a session whose transcript names one file says nothing about another of the same basename", () => {
    const rows = [row("s1", { project_path: "/r", activity: { text: "Editing index.ts", tool: "Edit", at: NOW - 1000 } })];
    const idx = index(rows, { s1: [edit("/r/src/a/index.ts")] });
    expect(writerFor(idx, "/r/src/a/index.ts")).toBe("s1");
    expect(writerFor(idx, "/r/src/b/index.ts", () => true)).toBeNull();
  });

  it("a strong conflict is not rescued by a weak hint", () => {
    const rows = [row("s1", { activity: { text: "Editing x.ts", tool: "Edit", at: NOW } }), row("s2")];
    const idx = index(rows, { s1: [edit("/r/app/x.ts")], s2: [edit("/r/app/x.ts")] });
    expect(writerFor(idx, "/r/app/x.ts")).toBeNull();
  });

  it("the digest changes only with the evidence", () => {
    const a = index([row("s1")], { s1: [edit("/r/app/x.ts")] });
    const b = index([row("s1")], { s1: [edit("/r/app/x.ts", 2000)] });
    const c = index([row("s1")], { s1: [edit("/r/app/y.ts")] });
    expect(editIndexDigest(a)).toBe(editIndexDigest(b));
    expect(editIndexDigest(a)).not.toBe(editIndexDigest(c));
  });
});
