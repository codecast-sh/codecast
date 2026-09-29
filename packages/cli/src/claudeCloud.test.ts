import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClaudeCloudWatcher, cloudEventToTranscriptLine, repoFromSourceUrl, type CloudEvent } from "./claudeCloud";
import { extractCwd, extractSummaryTitle, parseSessionFile } from "./parser";
import type { SessionEvent } from "./sessionWatcher";

const SID = "e81bd365-595d-577b-8e48-1b696e14393b";

function ev(seq: number, payload: Record<string, any>): CloudEvent {
  return { event_id: `evt-${seq}`, sequence_num: String(seq), created_at: `2026-09-29T07:25:${String(seq).padStart(2, "0")}.000Z`, payload };
}

// The shape the events endpoint returned for a real cloud session.
const EVENTS: CloudEvent[] = [
  ev(1, { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: "Read README.md and reply with its first heading only." } }),
  ev(2, { type: "env_manager_log", data: { content: "Allocating sandbox" } }),
  ev(3, { type: "system", subtype: "init", session_id: SID }),
  ev(4, { type: "assistant", session_id: SID, uuid: "a-1", timestamp: "2026-09-29T07:25:39.000Z", parent_tool_use_id: null,
    message: { id: "msg_1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/home/user/repo/README.md" } }] } }),
  ev(5, { type: "user", session_id: SID, uuid: "u-2", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "# codecast" }] } }),
  ev(6, { type: "assistant", session_id: SID, uuid: "sub-1", parent_tool_use_id: "toolu_9", message: { role: "assistant", content: [{ type: "text", text: "subagent" }] } }),
  ev(7, { type: "assistant", session_id: SID, uuid: "a-3", timestamp: "2026-09-29T07:25:40.000Z", parent_tool_use_id: null,
    message: { id: "msg_2", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "codecast" }] } }),
  ev(8, { type: "result", subtype: "success", session_id: SID }),
];

describe("cloudEventToTranscriptLine", () => {
  test("keeps top-level turns and stamps the fields a local transcript carries", () => {
    const line = cloudEventToTranscriptLine(EVENTS[0], { sessionId: SID, cwd: "/src/codecast", gitBranch: "main" })!;
    expect(line.type).toBe("user");
    expect(line.uuid).toBe("evt-1");
    expect(line.timestamp).toBe(EVENTS[0].created_at);
    expect(line.sessionId).toBe(SID);
    expect(line.cwd).toBe("/src/codecast");
    expect(line.gitBranch).toBe("main");
    expect(line).not.toHaveProperty("session_id");
  });

  test("drops plumbing and subagent traffic", () => {
    for (const i of [1, 2, 5, 7]) expect(cloudEventToTranscriptLine(EVENTS[i], { sessionId: SID, cwd: "/x" })).toBeNull();
  });
});

describe("repoFromSourceUrl", () => {
  test("parses github urls", () => {
    expect(repoFromSourceUrl("https://github.com/codecast-sh/codecast")).toEqual({ owner: "codecast-sh", name: "codecast" });
    expect(repoFromSourceUrl("git@github.com:codecast-sh/codecast.git")).toEqual({ owner: "codecast-sh", name: "codecast" });
    expect(repoFromSourceUrl(undefined)).toBeNull();
  });
});

describe("ClaudeCloudWatcher", () => {
  function setup(opts: { events: CloudEvent[]; rows?: any[] }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cloud-"));
    let events = opts.events;
    const calls: string[] = [];
    const rows = opts.rows ?? [
      { id: "cse_1", title: "Cloud task", environment_kind: "anthropic_cloud", created_at: "2026-09-29T07:25:28Z", last_event_at: "2026-09-29T07:25:41Z",
        config: { sources: [{ type: "git_repository", url: "https://github.com/codecast-sh/codecast", revision: "main" }] } },
      { id: "cse_bridge", environment_kind: "bridge", created_at: "2026-09-29T07:00:00Z", last_event_at: "2026-09-29T07:20:00Z" },
    ];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname === "/v1/code/sessions") return new Response(JSON.stringify({ data: rows }));
      const cursor = Number(u.searchParams.get("cursor") ?? 0);
      const data = events.filter((e) => Number(e.sequence_num) > cursor);
      return new Response(JSON.stringify({ data, resume_cursor: String(data.at(-1)?.sequence_num ?? cursor) }));
    }) as unknown as typeof fetch;
    const emitted: SessionEvent[] = [];
    const w = new ClaudeCloudWatcher({
      rootDir: dir, fetchImpl, readToken: async () => "tok", now: () => Date.parse("2026-09-29T08:00:00Z"),
      resolveRepoDir: (r) => (r.name === "codecast" ? "/Users/me/src/codecast" : null),
    });
    w.on("session", (e: SessionEvent) => emitted.push(e));
    return { dir, w, emitted, calls, setEvents: (e: CloudEvent[]) => { events = e; }, rows };
  }

  test("mirrors a cloud session into a Claude transcript the parser reads", async () => {
    const { w, emitted, calls } = setup({ events: EVENTS });
    await w.poll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].sessionId).toBe(SID);
    expect(emitted[0].projectPath).toBe("-Users-me-src-codecast");
    expect(calls.some((c) => c.includes("cse_bridge"))).toBe(false);

    const content = fs.readFileSync(emitted[0].filePath, "utf-8");
    expect(extractCwd(content)).toBe("/Users/me/src/codecast");
    expect(extractSummaryTitle(content)).toBe("Cloud task");
    const msgs = parseSessionFile(content);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs[1].toolCalls?.[0]?.name).toBe("Read");
    expect(msgs.at(-1)?.content).toBe("codecast");
    expect(msgs[0].content).toContain("Read README.md");
  });

  test("appends only new events on the next change, chaining parentUuid", async () => {
    const t = setup({ events: EVENTS });
    await t.w.poll();
    const file = t.emitted[0].filePath;
    const before = fs.readFileSync(file, "utf-8").trim().split("\n").length;

    // Unchanged last_event_at: no event fetch at all.
    t.calls.length = 0;
    await t.w.poll();
    expect(t.calls.filter((c) => c.includes("/events"))).toHaveLength(0);

    t.setEvents([...EVENTS, ev(9, { type: "user", session_id: SID, uuid: "u-4", parent_tool_use_id: null, message: { role: "user", content: "thanks" } })]);
    t.rows[0].last_event_at = "2026-09-29T07:30:00Z";
    await t.w.poll();
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(before + 1);
    expect(lines.at(-1).uuid).toBe("u-4");
    expect(lines.at(-1).parentUuid).toBe("a-3");
    expect(t.emitted.at(-1)?.eventType).toBe("change");
  });

  test("waits for the sandbox's session uuid before writing anything", async () => {
    const t = setup({ events: EVENTS.slice(0, 2) });
    await t.w.poll();
    expect(t.emitted).toHaveLength(0);
    t.setEvents(EVENTS);
    t.rows[0].last_event_at = "2026-09-29T07:40:00Z";
    await t.w.poll();
    expect(t.emitted).toHaveLength(1);
    const first = JSON.parse(fs.readFileSync(t.emitted[0].filePath, "utf-8").split("\n")[1]);
    expect(first.uuid).toBe("evt-1");
  });

  test("resumes from persisted state across restarts", async () => {
    const t = setup({ events: EVENTS });
    await t.w.poll();
    const w2 = new ClaudeCloudWatcher({ rootDir: t.dir, fetchImpl: (async () => new Response(JSON.stringify({ data: t.rows }))) as any, readToken: async () => "tok", now: () => Date.parse("2026-09-29T08:00:00Z") });
    const emitted: SessionEvent[] = [];
    w2.on("session", (e: SessionEvent) => emitted.push(e));
    w2.start(); w2.stop();
    await w2.poll();
    expect(emitted).toHaveLength(0);
  });

  test("skips the poll without a usable token", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cloud-"));
    let called = false;
    const w = new ClaudeCloudWatcher({ rootDir: dir, readToken: async () => null, fetchImpl: (async () => { called = true; return new Response("{}"); }) as any });
    await w.poll();
    expect(called).toBe(false);
  });
});
