import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessage } from "../chat/ChatMessage";
import type { ChatMessageView } from "../chat/chatTypes";

// What the message row actually emits. Two of these are regressions with teeth:
// the timestamp's link, and the markdown pipeline chat renders teammate text
// through.

const CHANNEL = "chan1234567890123456789012345678";
const MESSAGE = "msg12345678901234567890123456789";

function view(overrides: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id: MESSAGE,
    author: { id: "u1", name: "Ada Lovelace" },
    content: "hello there",
    createdAt: Date.parse("2026-08-12T15:04:00Z"),
    mentionsMe: false,
    ...overrides,
  } as ChatMessageView;
}

describe("ChatMessage", () => {
  test("the timestamp is the real permalink, not a DOM fragment", () => {
    const html = renderToStaticMarkup(
      <ChatMessage message={view()} channelId={CHANNEL} now={Date.now()} />,
    );
    expect(html).toContain(`href="/chat/${CHANNEL}?m=${MESSAGE}"`);
    expect(html).not.toContain(`href="#chatmsg-${MESSAGE}"`);
  });

  test("a bidi override in a teammate's message is rendered visible, not obeyed", () => {
    // remarkSanitizeInvisibleUnicode, which chat used to be assembled without.
    const html = renderToStaticMarkup(
      <ChatMessage
        message={view({ content: "transfer ‮gnp.eanj‬ now" })}
        channelId={CHANNEL}
        now={Date.now()}
      />,
    );
    expect(html).toContain("[U+202E]");
    expect(html).not.toContain("‮");
  });

  test("the overflow button is absent when there is nothing behind it", () => {
    const html = renderToStaticMarkup(<ChatMessage message={view()} now={Date.now()} />);
    expect(html).not.toContain('title="More"');
  });

  test("…and present once the row knows its channel, so Copy link can work", () => {
    const html = renderToStaticMarkup(
      <ChatMessage message={view()} channelId={CHANNEL} now={Date.now()} />,
    );
    expect(html).toContain('title="More"');
  });

  test("every reaction pill carries its own emoji", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={view({
          reactions: [
            { emoji: "🎉", count: 2, mine: false },
            { emoji: "🚀", count: 1, mine: true },
          ],
        })}
        channelId={CHANNEL}
        now={Date.now()}
        onReact={() => {}}
      />,
    );
    expect(html).toContain("🎉");
    expect(html).toContain("🚀");
  });
});
