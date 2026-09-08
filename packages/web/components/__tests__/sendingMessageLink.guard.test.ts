import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sendingExcerpt } from "../../hooks/useJumpToSendingMessage";

const source = readFileSync(new URL("../ConversationView.tsx", import.meta.url), "utf8");

function block(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const card = () => block("function SessionMessageBlock(", "// ── Team chat");

// Naming the sender is not the same as showing where the message came from. The
// card offers the sending turn as its own link, in words, rather than leaving it
// to a reader who thinks to click a badge.
test("the card offers the sending message as a visible link", () => {
  expect(card()).toContain("Open the sending message");
});

// Both shapes of sender resolve: a teammate id or subagent name arrives already
// resolved to a conversation, a `cast send` names its sender by short id.
test("the link is offered for every sender the server can resolve", () => {
  expect(card()).toContain(
    'const senderRef = linkToConversationId ?? (!namedSender && from && from !== "unknown" ? from : undefined);',
  );
  expect(card()).toContain("useJumpToSendingMessage(senderRef, timestamp, body)");
});

test("the sender badge jumps to the same place as the link", () => {
  // Two affordances, one destination — a badge that only opened the session
  // would land the reader hours past the message it belongs to.
  expect(card().match(/void jumpToSendingMessage\(\)/g)?.length).toBe(2);
});

test("the excerpt is the head of the body, whitespace and all", () => {
  expect(sendingExcerpt("  Review task ct-49576\n\nfor plan pl-552  ")).toBe("Review task ct-49576\n\nfor plan pl-552");
  expect(sendingExcerpt("x".repeat(500)).length).toBe(240);
  expect(sendingExcerpt("")).toBe("");
});
