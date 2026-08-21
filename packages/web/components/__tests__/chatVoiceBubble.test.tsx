import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { bindWalkie } from "../../lib/calls/walkie";
import { walkieBlockedReason, walkieJoinReason, walkieOwnsCall } from "../../hooks/useWalkie";
import { useInboxStore } from "../../store/inboxStore";
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
    expect(walkieOwnsCall(status as any, inRoom, { guest: false })).toBe(true);
  });

  test("a burst into some OTHER room leaves this call's dock alone", () => {
    const status = {
      ...base,
      incoming: { channelId: "c", messageId: "m", roomKey: "dm:x:y", fromUserId: "u", fromName: "Ada" },
    };
    expect(walkieOwnsCall(status as any, inRoom, { guest: false })).toBe(false);
  });

  test("an open mic hands the room back: a room somebody talks in is a huddle", () => {
    const lingering = { ...base, lingerUntil: Date.now() + 30_000 };
    expect(walkieOwnsCall(lingering as any, inRoom, { lingerRoom: ROOM, guest: false })).toBe(true);
    expect(
      walkieOwnsCall(lingering as any, { ...inRoom, muted: false }, { lingerRoom: ROOM, guest: false }),
    ).toBe(false);
  });

  test("walking into a huddle during the linger gets the CALL dock, not the strip", () => {
    // The engine holds a room open for half a minute after a burst and does not
    // clear that when the person joins something else. Owning "whatever room we
    // happen to be in" would put the walkie strip — no mic, no hang-up, the
    // wrong name — over a real call for up to 30 seconds.
    const lingering = { ...base, lingerUntil: Date.now() + 30_000 };
    const huddle = { roomKey: "channel:elsewhere", phase: "connected", muted: true };
    expect(walkieOwnsCall(lingering as any, huddle, { lingerRoom: ROOM, guest: false })).toBe(false);
  });

  test("an ordinary huddle is never the walkie's", () => {
    expect(walkieOwnsCall(base as any, inRoom, { lingerRoom: null })).toBe(false);
    expect(walkieOwnsCall(base as any, idle, { lingerRoom: null })).toBe(false);
  });

  test("a burst inside a LIVE UNMUTED call leaves that call its own dock", () => {
    // The room keys match exactly when the answer must be no: a 1:1 call lives
    // in the same dm: room a burst to that person is spoken into. Taking the
    // dock here would strip a call in progress of its hang-up, mute, camera and
    // lock for the length of a sentence.
    const live = { roomKey: ROOM, phase: "connected", muted: false };
    const sending = {
      ...base,
      sending: { channelId: "c", roomKey: ROOM, clientId: "cid", messageId: null, startedAt: 0, transcript: "" },
    };
    expect(walkieOwnsCall(sending as any, live, { guest: true })).toBe(false);

    const hearing = {
      ...base,
      incoming: { channelId: "c", messageId: "m", roomKey: ROOM, fromUserId: "u", fromName: "Ada" },
    };
    // Two guards, either of which is enough on its own: the room was already a
    // conversation, and the mic in it is open.
    expect(walkieOwnsCall(hearing as any, live, { guest: true })).toBe(false);
    expect(walkieOwnsCall(hearing as any, live, { guest: false })).toBe(false);

    // And the linger afterwards is still inside that same huddle.
    const lingering = { ...base, lingerUntil: Date.now() + 30_000 };
    expect(walkieOwnsCall(lingering as any, { ...live, muted: true }, { lingerRoom: ROOM, guest: true })).toBe(
      false,
    );
  });

  test("a burst that OPENED its room still owns the dock while it is spoken", () => {
    // The engine unmutes to publish the mic, so an unmuted room is not by itself
    // a huddle — what matters is whether it was one before the key went down.
    const sending = {
      ...base,
      sending: { channelId: "c", roomKey: ROOM, clientId: "cid", messageId: null, startedAt: 0, transcript: "" },
    };
    const opened = { roomKey: ROOM, phase: "connected", muted: false };
    expect(walkieOwnsCall(sending as any, opened, { guest: false })).toBe(true);
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

describe("when push to talk refuses", () => {
  function callPlane(patch: Record<string, unknown>) {
    useInboxStore.setState({
      call: { phase: "idle", roomKey: null, muted: true, camera: false, sharing: false, speaking: [], error: null, ...patch },
    } as any);
  }

  test("a mic already open in this room: talking IS the walkie", () => {
    // The engine lets push-to-talk through for the room you are in, because
    // that is how the receiving side replies from inside it. But when your own
    // mic is already open there, holding the key would take the call's controls
    // away for a sentence and then MUTE the call on release — the engine
    // tidying up after a burst, doing real damage to a conversation.
    callPlane({ phase: "connected", roomKey: ROOM, muted: false });
    expect(walkieBlockedReason(ROOM)).toBe("Your mic is already open here — just talk");
    // Standing in the room is still allowed; only talking into it twice is not.
    expect(walkieJoinReason(ROOM)).toBe(null);
  });

  test("but a MUTED room is exactly where hold-to-reply lives", () => {
    // The receiver auto-joins muted to hear a burst. Blocking the key here
    // would take away the answer, which is the whole receiving half.
    callPlane({ phase: "connected", roomKey: ROOM, muted: true });
    expect(walkieBlockedReason(ROOM)).toBe(null);
  });

  test("a room nobody is in is open for business", () => {
    callPlane({});
    expect(walkieBlockedReason(ROOM)).toBe(null);
    expect(walkieBlockedReason(undefined)).toBe("There is nobody to talk to here yet");
  });
});
