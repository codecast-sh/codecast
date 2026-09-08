import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseAgentAuthoredMessage } from "../sessionMessage";

const source = readFileSync(new URL("../ConversationView.tsx", import.meta.url), "utf8");

function block(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

// A subagent's report to the session that launched it arrives as a user-role row
// wrapped in <agent-message from="…">. Before this rail existed the transcript
// showed the wire tag verbatim under the human's name and avatar.
test("the classifier routes a subagent report onto the session-message rail", () => {
  const classifier = block("function classifyUserMessage(", "function isStickyWorthy(");
  expect(classifier).toContain("isAgentMessage(t)");
  expect(classifier).toContain("parseAgentAuthoredMessage(t)");
  expect(classifier).toMatch(/kind: 'session_message',[^\n]*variant: 'agent'/);
});

test("the card gets the agent variant and the sender's session when it resolves", () => {
  const renderCase = block("case 'session_message':", "case 'huddle_summary':");
  expect(renderCase).toContain(`variant={kind.variant === 'agent' ? "agent" : "session"}`);
  expect(renderCase).toContain("agentNameToChildMap?.[kind.from]");
});

test("an agent name is a badge, never an EntityIdPill", () => {
  const card = block("function SessionMessageBlock(", "// ── Team chat");
  // A subagent name and a teammate id both fail to resolve as session short ids,
  // so both take the badge branch; only a real session id gets the pill.
  expect(card).toContain("const namedSender = isTeammate || isAgentReport;");
  expect(card).toMatch(/\{namedSender \? \(/);
});

test("the parser strips the envelope both rails share", () => {
  const report = parseAgentAuthoredMessage('<agent-message from="critic-K-L">\nsweep done\n</agent-message>');
  expect(report).toEqual({ from: "critic-K-L", body: "sweep done", label: "report from" });
  const sent = parseAgentAuthoredMessage('<session-message from="jx7c6zk">\ntake the auth half\n</session-message>');
  expect(sent).toEqual({ from: "jx7c6zk", body: "take the auth half", label: "message from" });
});
