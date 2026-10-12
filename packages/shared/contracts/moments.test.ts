import { describe, expect, it } from "bun:test";
import { DEFAULT_QUIET_MS, MOMENT_LIMITS, parseDuration, parseExtractorHeader, parseExtractorOutput, renderMoment, validateMomentEvent, type MomentRecord } from "./moments";
import { validateIngestBatch } from "./ingest";

const T = Date.parse("2026-10-09T14:00:00Z");

describe("the moment event at the door (LL7)", () => {
  it("keeps kind, subject and refs, lowercasing the kind", () => {
    expect(validateMomentEvent({ kind: "Conversation", subject: " thread_81 ", refs: { thread: "t_81", n: 3 } }, T)).toEqual({ type: "moment", kind: "conversation", subject: "thread_81", refs: { thread: "t_81", n: "3" }, at: T });
  });

  it("refuses a kind that cannot name a file, and a missing subject", () => {
    expect(validateMomentEvent({ kind: "../etc", subject: "x" }, T)).toContain("kind");
    expect(validateMomentEvent({ kind: "call", subject: "  " }, T)).toBe("moment needs a subject");
  });

  it("rides the ingest batch as its own item type", () => {
    const r = validateIngestBatch({ items: [{ type: "moment", kind: "call", subject: "c_1", at: T }, { type: "moment", kind: "", subject: "c" }] }, T + 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toEqual([{ type: "moment", kind: "call", subject: "c_1", at: T }]);
    expect(r.rejected[0].index).toBe(1);
  });
});

describe("an extractor's output", () => {
  const good = {
    blocks: [
      { type: "message", direction: "in", channel: "sms", at: "2026-10-09T13:58:00Z", sender: "Dana", body: "Can we talk Tuesday?" },
      { type: "message", direction: "out", channel: "sms", at: T - 60_000, body: "Tuesday at 2 works.", delivery: "queued" },
      { type: "facts", title: "Contact", facts: [{ label: "Stage", value: "intro sent" }, { label: "Opted out", value: false }, { label: "Owner", value: null }] },
      { type: "text", text: "Broker asked for a call twice before." },
    ],
    refs: [{ label: "thread", id: "t_81", url: "https://app.example/t/81" }, { label: "bad", id: "x", url: "javascript:alert(1)" }],
  };

  it("parses every block kind and drops unsafe urls", () => {
    const out = parseExtractorOutput(JSON.stringify(good));
    if ("error" in out) throw new Error(out.error);
    expect(out.blocks).toHaveLength(4);
    expect(out.blocks[0]).toMatchObject({ direction: "in", at: T - 120_000, sender: "Dana" });
    expect(out.blocks[2]).toEqual({ type: "facts", title: "Contact", facts: [{ label: "Stage", value: "intro sent" }, { label: "Opted out", value: "false" }, { label: "Owner", value: "none" }] });
    expect(out.refs).toEqual([{ label: "thread", id: "t_81", url: "https://app.example/t/81" }, { label: "bad", id: "x" }]);
  });

  it("refuses rather than trims", () => {
    expect(parseExtractorOutput("not json")).toEqual({ error: "the extractor did not print JSON" });
    expect(parseExtractorOutput({ blocks: [{ type: "message", direction: "sideways", at: T, body: "x" }] })).toEqual({ error: 'block 0: a message\'s direction is "in" or "out"' });
    expect(parseExtractorOutput({ blocks: Array.from({ length: MOMENT_LIMITS.blocks + 1 }, () => ({ type: "text", text: "x" })) })).toMatchObject({ error: expect.stringContaining("at most") });
  });

  it("renders a conversation with time, direction, channel and delivery, then facts", () => {
    const out = parseExtractorOutput(good);
    if ("error" in out) throw new Error(out.error);
    const record: MomentRecord = { ...out, kind: "conversation", subject: "t_81", event_at: T, extracted_at: T + 300_000, gap_ms: 300_000, extractor: { path: ".codecast/moments/conversation.ts", version: "abc" } };
    expect(renderMoment(record)).toBe(
      [
        "Moment: conversation for t_81, happened 2026-10-09T14:00:00Z.",
        "From: thread t_81, bad x",
        "",
        "## Conversation",
        "[2026-10-09T13:58:00Z] in from Dana, sms:",
        "  Can we talk Tuesday?",
        "[2026-10-09T13:59:00Z] out from us, sms [queued]:",
        "  Tuesday at 2 works.",
        "",
        "## Contact",
        "- Stage: intro sent",
        "- Opted out: false",
        "- Owner: none",
        "",
        "## Note",
        "Broker asked for a call twice before.",
        "",
      ].join("\n"),
    );
  });
});

describe("an extractor's header", () => {
  it("reads quiet and timeout from the opening comments", () => {
    expect(parseExtractorHeader("// Conversations, for the comms judge.\n// quiet: 10m\n// timeout: 90s\nimport x from 'y';\n// quiet: 1h")).toEqual({ quiet_ms: 600_000, timeout_ms: 90_000, problems: [] });
  });

  it("keeps defaults and names a bad value", () => {
    const h = parseExtractorHeader("// quiet: soon\nexport {}");
    expect(h.quiet_ms).toBe(DEFAULT_QUIET_MS);
    expect(h.problems[0]).toContain("quiet");
  });

  it("parses durations", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("45")).toBe(45_000);
    expect(parseDuration("1d")).toBeNull();
  });
});
