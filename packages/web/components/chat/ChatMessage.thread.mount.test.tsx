import assert from "node:assert/strict";
import { test } from "bun:test";
import { replaceGlobals } from "../../test-helpers/globals";
import type { ChatMessageView } from "./chatTypes";

// Threads are flat: the server refuses a reply whose root is itself a reply.
// A broadcast reply sits in the channel timeline, so every way it offers into
// a thread must open its root, never the reply.
test("a broadcast reply opens its root's thread", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://local.codecast.sh/chat/c1" });
  const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChatMessage } = await import("./ChatMessage");
  const message: ChatMessageView = {
    id: "reply1",
    author: { id: "u1", name: "Ashot" },
    content: "also sent to the channel",
    createdAt: Date.UTC(2026, 10, 7, 22, 6),
    threadRootId: "root1",
  };
  const opened: string[] = [];
  const root = createRoot(document.getElementById("root")!);
  try {
    await React.act(async () =>
      root.render(<ChatMessage message={message} channelId="c1" now={message.createdAt} onOpenThread={(id) => opened.push(id)} />),
    );
    const replyTool = document.querySelector<HTMLButtonElement>('button[title="Reply in thread"]');
    assert.ok(replyTool, "reply tool rendered");
    await React.act(async () => replyTool!.click());
    const ctx = document.querySelector<HTMLButtonElement>(".ch-msg-threadctx");
    assert.ok(ctx, "thread context line rendered");
    await React.act(async () => ctx!.click());
    assert.deepEqual(opened, ["root1", "root1"]);
  } finally {
    await React.act(async () => root.unmount());
    restore();
  }
}, 120_000);
