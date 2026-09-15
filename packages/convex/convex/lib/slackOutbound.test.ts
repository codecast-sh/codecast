import { describe, expect, test } from "bun:test";
import { isAgentLine, linkReceivesInbound, linkSendsOutbound, outboundSkipReason } from "./slackOutbound";

const link: any = {
  paused: false,
  direction: "both",
  options: { threads: true, reactions: true, edits: true, files: true, bot_messages: false, system_messages: false, agent_lines: true, match_people_by_email: true },
};
const msg = (over: Record<string, unknown> = {}): any => ({
  _id: "m1", channel_id: "c1", user_id: "u1", author_kind: "user", content: "hello", created_at: 1, updated_at: 1, ...over,
});

describe("direction", () => {
  test("both flows both ways; one way flows one way; paused flows nowhere", () => {
    expect(linkSendsOutbound(link)).toBe(true);
    expect(linkReceivesInbound(link)).toBe(true);
    expect(linkSendsOutbound({ ...link, direction: "slack_to_codecast" })).toBe(false);
    expect(linkReceivesInbound({ ...link, direction: "slack_to_codecast" })).toBe(true);
    expect(linkSendsOutbound({ ...link, direction: "codecast_to_slack" })).toBe(true);
    expect(linkReceivesInbound({ ...link, direction: "codecast_to_slack" })).toBe(false);
    expect(linkSendsOutbound({ ...link, paused: true })).toBe(false);
    expect(linkReceivesInbound({ ...link, paused: true })).toBe(false);
  });
});

describe("outboundSkipReason", () => {
  test("a plain line goes", () => {
    expect(outboundSkipReason(link, msg())).toBeNull();
  });
  test("a line from Slack never goes back", () => {
    expect(outboundSkipReason(link, msg({ external: { direction: "inbound" } }))).toBe("from_slack");
    expect(outboundSkipReason(link, msg({ external: { direction: "outbound" } }))).toBe("already_sent");
  });
  test("author controls and link controls", () => {
    expect(outboundSkipReason(link, msg({ sync_local_only: true }))).toBe("local_only");
    expect(outboundSkipReason({ ...link, paused: true }, msg())).toBe("paused");
    expect(outboundSkipReason({ ...link, direction: "slack_to_codecast" }, msg())).toBe("direction");
    expect(outboundSkipReason({ ...link, options: { ...link.options, threads: false } }, msg({ thread_root_id: "r" }))).toBe("threads_off");
    expect(outboundSkipReason({ ...link, options: { ...link.options, agent_lines: false } }, msg({ author_kind: "agent" }))).toBe("agent_lines_off");
    expect(outboundSkipReason({ ...link, options: { ...link.options, agent_lines: false } }, msg({ origin: "agent" }))).toBe("agent_lines_off");
    expect(outboundSkipReason(link, msg({ author_kind: "agent", agent_status: "done" }))).toBeNull();
  });
  test("rows that are not lines", () => {
    expect(outboundSkipReason(link, msg({ deleted_at: 5 }))).toBe("deleted");
    expect(outboundSkipReason(link, msg({ voice: { status: "done" } }))).toBe("voice");
    expect(outboundSkipReason(link, msg({ call: { transcript_id: "t" } }))).toBe("voice");
    expect(outboundSkipReason(link, msg({ agent_status: "thinking", author_kind: "agent" }))).toBe("agent_pending");
    expect(outboundSkipReason(link, msg({ content: "  " }))).toBe("empty");
    expect(outboundSkipReason(link, msg({ content: "", attachments: [{ storage_id: "s" }] }))).toBeNull();
  });
  test("isAgentLine", () => {
    expect(isAgentLine(msg())).toBe(false);
    expect(isAgentLine(msg({ author_kind: "agent" }))).toBe(true);
    expect(isAgentLine(msg({ origin: "agent" }))).toBe(true);
  });
});
