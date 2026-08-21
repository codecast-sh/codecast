import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { bindWalkie } from "../../lib/calls/walkie";
import { walkieOwnsCall } from "../../hooks/useWalkie";
import { voiceDuration } from "../../lib/voicePlayer";
import { ChatMessage } from "../chat/ChatMessage";
import type { ChatMessageView } from "../chat/chatTypes";

// What a walkie burst emits in the timeline. The regressions with teeth are all
// about which branch wins: a burst must not fall through to the plain markdown
// body (its audio attachment would render as a broken image), a canceled one
// must not pulse at anybody, and the transcript has to be readable in every
// state — reading is the whole product argument for transcribing at all.

const CHANNEL = "chan1234567890123456789012345678";
const MESSAGE = "msg12345678901234567890123456789";
const ROOM = "dm:aaa:bbb";

function view(overrides: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id: MESSAGE,
    author: { id: "u1", name: "Ada Lovelace" },
    content: "",
    createdAt: Date.parse("2026-08-12T15:04:00Z"),
    mentionsMe: false,
    ...overrides,
  } as ChatMessageView;
}

// Until React binds a live Convex client the walkie reports "not ready" and
// every door is shut, which is correct and is also not the case worth testing.
beforeAll(() => {
  bindWalkie({ mutation: async () => null, action: async () => null });
});

function render(message: ChatMessageView): string {
  return renderToStaticMarkup(
    <ChatMessage message={message} channelId={CHANNEL} now={Date.now()} />,
  );
}

describe("voice bubble", () => {
  test("a live burst pulses, says who to join, and shows the words so far", () => {
    const html = render(
      view({ content: "can you look at the deploy", voice: { status: "live", roomKey: ROOM } }),
    );
    expect(html).toContain("ch-voice-live");
    expect(html).toContain("ch-voice-dot");
    expect(html).toContain("can you look at the deploy");
    // The room is joinable, so the bubble is the door into it.
    expect(html).toContain(`data-walkie-live="${MESSAGE}"`);
    expect(html).toContain("Join the room and talk back");
    expect(html).not.toContain("disabled");
  });

  test("a live burst nobody can join says so instead of offering a dead door", () => {
    const html = render(view({ content: "hello", voice: { status: "live" } }));
    expect(html).toContain("disabled");
    expect(html).toContain("This one cannot be joined");
  });

  test("a burst with no words yet still reads as something happening", () => {
    const html = render(view({ voice: { status: "live", roomKey: ROOM } }));
    expect(html).toContain("talking…");
  });

  test("a finished burst is its transcript, its length, and a play button", () => {
    const html = render(
      view({
        content: "shipping it now",
        voice: { status: "done", durationMs: 7_400 },
        attachments: [{ storage_id: "st1", mime: "audio/webm" }],
      }),
    );
    expect(html).toContain("shipping it now");
    expect(html).toContain("0:07");
    expect(html).toContain(`data-walkie-play="${MESSAGE}"`);
    // Never the image tile path: an audio storage id in an <img> is a broken
    // thumbnail where a voice note should be.
    expect(html).not.toContain("ch-att");
    expect(html).not.toContain("ch-voice-dot");
  });

  test("a burst whose recording never uploaded still carries what was said", () => {
    const html = render(
      view({ content: "the words survived", voice: { status: "done", durationMs: 3_000 } }),
    );
    expect(html).toContain("the words survived");
    expect(html).toContain("ch-voice-noaudio");
    expect(html).not.toContain("data-walkie-play");
  });

  test("a canceled burst reads as deleted, never as somebody talking", () => {
    // toMessageViews drops a brushed key from the timeline entirely; this is the
    // one that survives it, the burst somebody replied to. Either way the row
    // must never keep pulsing, so the deleted branch has to win over the voice
    // branch below it.
    const html = render(
      view({ voice: { status: "canceled" }, deletedAt: Date.now() }),
    );
    expect(html).toContain("This message was deleted");
    expect(html).not.toContain("ch-voice");
  });

  test("a transcript is speech, not markdown: its punctuation stays literal", () => {
    // A recognizer writes what it heard. Running that through the markdown
    // pipeline a typed message uses would turn somebody saying "star star" into
    // formatting, and swallow the characters that carried the meaning.
    const spoken = "use **kwargs and a # comment";
    const html = render(view({ content: spoken, voice: { status: "done", durationMs: 2_000 } }));
    expect(html).toContain("use **kwargs and a # comment");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<h1");
  });
});

describe("who owns the dock", () => {
  const idle = { roomKey: null, phase: "idle", muted: true };
  const inRoom = { roomKey: ROOM, phase: "connected", muted: true };
  const base = {
    sending: null,
    incoming: null,
    lingerUntil: null,
    unavailable: null,
    canReply: false,
    error: null,
  } as const;

  test("a burst being heard owns the room, so the call dock stands down", () => {
    const status = {
      ...base,
      incoming: { channelId: "c", messageId: "m", roomKey: ROOM, fromUserId: "u", fromName: "Ada" },
    };
    expect(walkieOwnsCall(status as any, inRoom)).toBe(true);
  });

  test("a burst into some OTHER room leaves this call's dock alone", () => {
    const status = {
      ...base,
      incoming: { channelId: "c", messageId: "m", roomKey: "dm:x:y", fromUserId: "u", fromName: "Ada" },
    };
    expect(walkieOwnsCall(status as any, inRoom)).toBe(false);
  });

  test("an open mic hands the room back: a room somebody talks in is a huddle", () => {
    const lingering = { ...base, lingerUntil: Date.now() + 30_000 };
    expect(walkieOwnsCall(lingering as any, inRoom, ROOM)).toBe(true);
    expect(walkieOwnsCall(lingering as any, { ...inRoom, muted: false }, ROOM)).toBe(false);
  });

  test("walking into a huddle during the linger gets the CALL dock, not the strip", () => {
    // The engine holds a room open for half a minute after a burst and does not
    // clear that when the person joins something else. Owning "whatever room we
    // happen to be in" would put the walkie strip — no mic, no hang-up, the
    // wrong name — over a real call for up to 30 seconds.
    const lingering = { ...base, lingerUntil: Date.now() + 30_000 };
    const huddle = { roomKey: "channel:elsewhere", phase: "connected", muted: true };
    expect(walkieOwnsCall(lingering as any, huddle, ROOM)).toBe(false);
  });

  test("an ordinary huddle is never the walkie's", () => {
    expect(walkieOwnsCall(base as any, inRoom, null)).toBe(false);
    expect(walkieOwnsCall(base as any, idle, null)).toBe(false);
  });
});

describe("voiceDuration", () => {
  test("reads as a clock, rounded to the second", () => {
    expect(voiceDuration(0)).toBe("0:00");
    expect(voiceDuration(7_400)).toBe("0:07");
    expect(voiceDuration(64_000)).toBe("1:04");
    expect(voiceDuration(undefined)).toBe("0:00");
  });
});
