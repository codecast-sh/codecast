import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const identity = await import("../../hooks/useLiveIdentityRow");
mock.module("../../hooks/useLiveIdentityRow", () => ({ ...identity, useConversationSpeaker: () => ({ name: "Claude", row: null }) }));
mock.module("./CommentAvatar", () => ({ CommentAvatar: () => null }));
mock.module("./CommentMarkdown", () => ({ CommentMarkdown: ({ content }: { content: string }) => <p>{content}</p> }));
const { CommentCard } = await import("./CommentCard");

const ASKER = "user_1";
const placeholder = (over: Record<string, unknown> = {}) => ({
  _id: "c1", conversation_id: "conv_1", user_id: ASKER, content: "", created_at: 1, author_kind: "agent", agent_status: "thinking", ...over,
}) as any;

let root: Root;
let deleted: string[];
let retries: number;
const render = (comment: any, currentUserId = ASKER) => act(async () => root.render(
  <CommentCard
    comment={comment}
    conversationId="conv_1"
    currentUserId={currentUserId}
    onReply={() => {}}
    onEdit={() => {}}
    onDelete={(id) => { deleted.push(id); }}
    onRetryAgent={() => { retries++; }}
  />,
));

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  deleted = [];
  retries = 0;
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("an agent reply placeholder", () => {
  test("thinking shows the spinner and no retry", async () => {
    await render(placeholder());
    expect(document.body.textContent).toContain("thinking");
    expect(document.querySelector("[data-comment-agent-retry]")).toBeNull();
  });

  test("error says why and offers a retry that replaces the failed row", async () => {
    await render(placeholder({ agent_status: "error", content: "Could not reach the agent: fork refused" }));
    expect(document.body.textContent).toContain("no reply");
    expect(document.body.textContent).toContain("fork refused");
    await act(async () => (document.querySelector("[data-comment-agent-retry]") as HTMLButtonElement).click());
    expect(deleted).toEqual(["c1"]);
    expect(retries).toBe(1);
  });

  test("a teammate who did not ask retries without touching the asker's row", async () => {
    await render(placeholder({ agent_status: "error", content: "Could not reach the agent: x" }), "user_2");
    await act(async () => (document.querySelector("[data-comment-agent-retry]") as HTMLButtonElement).click());
    expect(deleted).toEqual([]);
    expect(retries).toBe(1);
  });
});
