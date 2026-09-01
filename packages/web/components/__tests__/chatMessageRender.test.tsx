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

  test("a session-authored message links its session identity", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={view({
          author: {
            id: "u1",
            name: "C3 attrition carve-out decision",
            isAgent: true,
            session: {
              id: "jx7c12zp5w6xg1z6evdbyvkezs8dadbn",
              agentType: "claude_code",
              via: "Ashot Petrosian",
            },
          },
        })}
        channelId={CHANNEL}
        now={Date.now()}
      />,
    );
    expect(html).toContain('href="/conversation/jx7c12zp5w6xg1z6evdbyvkezs8dadbn"');
    expect(html).toContain('title="Open session"');
    expect(html).toContain("C3 attrition carve-out decision");
    expect(html).toContain("via Ashot Petrosian");
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

describe("mention chips share the doc editor's face", () => {
  test("a known handle renders the editor-mention chip with the display name", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={view({ content: "ping @samvit please" })}
        now={Date.parse("2026-08-13T15:00:00Z")}
        knownHandles={new Set(["samvit"])}
        handleNames={new Map([["samvit", "Samvit Ramadurgam"]])}
      />,
    );
    // The doc editor's classes, so both surfaces read one stylesheet.
    expect(html).toContain("editor-mention");
    expect(html).toContain("mention-person");
    // Stored text is the handle; the chip wears the person's name, and the
    // handle survives as the title for hover/copy orientation.
    expect(html).toContain("@Samvit Ramadurgam");
    expect(html).toContain('title="@samvit"');
  });

  test("an unknown @word stays plain text", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={view({ content: "email a@b.com and @nobody" })}
        now={Date.parse("2026-08-13T15:00:00Z")}
        knownHandles={new Set(["samvit"])}
      />,
    );
    expect(html).not.toContain("editor-mention");
  });
});
