import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { bindWalkie } from "../../lib/calls/walkie";
import { callDockSurface, walkieBlockedReason, walkieBurstDropped, walkieJoinReason, walkieKeyName, walkieKeyState } from "../../hooks/useWalkie";
import { useInboxStore } from "../../store/inboxStore";
import { voiceDuration } from "../../lib/voicePlayer";
import { ChatMessage } from "../chat/ChatMessage";
import { toMessageView } from "../../lib/chatViews";
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

const TEAM = "team1234567890123456789012345678";

/** Calls available: the deployment has LiveKit and the active team has the
 *  feature on. Since ct-44931 round 5 this is a precondition of every walkie
 *  gesture, for the same reason a bound Convex client is — without it the
 *  answer to every question below is "calls are not on", which is correct and
 *  is not the case worth testing. */
function callsOn(on = true) {
  useInboxStore.setState({
    callConfig: { enabled: on, url: "wss://x", teams: [TEAM] },
    teams: [{ _id: TEAM, features: { calls: on, chat: true } }],
    clientState: { ...(useInboxStore.getState() as any).clientState, ui: { active_team_id: TEAM } },
  } as any);
}

// Until React binds a live Convex client the walkie reports "not ready" and
// every door is shut, which is correct and is also not the case worth testing.
beforeAll(() => {
  bindWalkie({ mutation: async () => null, action: async () => null });
  callsOn();
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
    expect(html).toContain("This burst has no room to join");
  });

  test("a burst with no words yet says which silence this is", () => {
    // The pulsing dot already says somebody is talking. What only this line can
    // say is that nothing has been heard so far — and it uses the same words as
    // the finished bubble's "no words", so the pair reads as one fact at two
    // moments: not yet, and never.
    const live = render(view({ voice: { status: "live", roomKey: ROOM } }));
    expect(live).toContain("no words yet");
    const done = render(view({ voice: { status: "done", durationMs: 2_000 } }));
    expect(done).toContain("no words");
    expect(done).not.toContain("no words yet");
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

// ── WHICH SURFACE THE DOCK SHOWS ───────────────────────────────────────────
//
// The walkie and the ordinary call dock are two surfaces for one room, and
// exactly one of them is right at any moment: a burst joins a room the same way
// a huddle does, so without this the floating call window would open for every
// sentence anybody says.
//
// The answer used to be assembled from six ordered rules over three fields, and
// it was wrong in ways only a test caught. The founder, holding the composer
// key: "it kind of switches to the full call unexpectedly after a few seconds."
// The full stage replaced his DM about a second into every hold, because a
// huddle he had expanded EARLIER in the session left `expanded` true and the
// branch read `walkieOwnsCall(...) && !expanded` (ct-45974, ct-46031).
//
// It is one fact read out now. Everything below is that fact from every angle
// the walkie can be in.
describe("which surface the dock shows", () => {
  const base = {
    sending: null,
    incoming: null,
    liveRoom: null,
    unavailable: null,
    canReply: false,
    asr: "live",
    error: null,
  } as const;
  /** The walkie in a room, as the engine publishes it. */
  const held = (mode: "burst" | "listen" | "call", key = ROOM) => ({
    ...base,
    liveRoom: { key, mode, since: 1_700_000_000_000 },
  });
  /** This client's own seat through a burst: the engine unmutes to publish. */
  const seated = { roomKey: ROOM, phase: "connected" };
  const huddle = { roomKey: "channel:elsewhere", phase: "connected" };
  const gone = { roomKey: null, phase: "idle" };
  const surface = (status: any, call: any, expanded = false, video = false) =>
    callDockSurface(status as any, call, { expanded, video });

  test("a burst and a listen both draw the strip, and nothing local outranks them", () => {
    // The regression itself: nothing about the burst differs between these two
    // calls, only a flag left behind by a huddle that ended minutes ago.
    expect(surface(held("burst"), seated)).toBe("walkie");
    expect(surface(held("burst"), seated, true)).toBe("walkie");
    expect(surface(held("listen"), seated)).toBe("walkie");
    expect(surface(held("listen"), seated, true)).toBe("walkie");
  });

  test("the room held open after the key comes up is still the walkie's", () => {
    // The gap this closes: between the burst clearing and the room being held
    // the engine used to answer for nobody, and the dock took a room the walkie
    // had not let go of — measured at 861ms, the length of the audio upload.
    // The live room spans the whole of it now, mic open or shut.
    expect(surface(held("burst"), { ...seated, muted: true })).toBe("walkie");
    expect(surface(held("listen"), { ...seated, muted: false })).toBe("walkie");
  });

  test("somebody stepping in on purpose keeps the walkie's shape while the room is voice", () => {
    // The founder's rule, restated for the fill-to-lock era: a walkie exchange
    // LOOKS LIKE FACES for as long as it is voices — the latch and Join live
    // both land on a circles card with Mute and End, not a video card for a
    // conversation with no video in it. Unmuting is still not a join signal
    // (ct-46032); and video or an expand still earns the room the real dock.
    expect(surface(held("call"), seated)).toBe("walkie");
    expect(surface(held("call"), seated, true)).toBe("stage");
    expect(surface(held("call"), seated, false, true)).toBe("dock");
  });

  test("a burst spoken inside a call with video leaves that call its own dock", () => {
    // The room keys match exactly when the video answer must hold: a 1:1 call
    // with a camera up lives in the same dm: room a burst to that person is
    // spoken into, and taking the dock away would strip it of its camera and
    // lock for the length of a sentence. A voice-only call keeps the walkie
    // card instead, which now carries its own hang-up and mute.
    expect(surface(held("call"), seated, false, true)).toBe("dock");
    expect(surface(held("call"), seated, true, true)).toBe("stage");
  });

  test("the room is read off the key it names, never a stale one", () => {
    // A call somebody joined and left must not turn the NEXT burst, in some
    // other room, into a call nobody joined.
    expect(surface(held("call", "dm:someone:else"), seated)).toBe("dock");
    expect(surface(held("burst", "dm:someone:else"), seated)).toBe("dock");
  });

  test("walking into a huddle while the walkie holds another room gets the CALL dock", () => {
    // The engine holds a room open for half a minute after a burst. Owning
    // "whatever room we happen to be in" would put the walkie strip — no mic,
    // no hang-up, the wrong name — over a real call for up to thirty seconds.
    expect(surface(held("burst"), huddle)).toBe("dock");
    expect(surface(held("burst"), huddle, true)).toBe("stage");
  });

  test("a burst that outlived its room keeps the strip", () => {
    // The room falls over under an open microphone: the call plane goes idle,
    // but the recorder, the meter and the recognizer are still running and the
    // message still lands.
    expect(surface(held("burst"), gone)).toBe("walkie");
    expect(surface(held("burst"), gone, true)).toBe("walkie");
  });

  test("no call at all shows nothing, however the stage was left", () => {
    // ct-45974, structurally rather than by a rule that has to remember: the
    // dock is mounted for the life of the page, and an expanded huddle used to
    // leave its flag true forever — so the next call, or the next burst, opened
    // full screen on its own with nobody having asked.
    expect(surface(base, gone)).toBe("none");
    expect(surface(base, gone, true)).toBe("none");
  });

  test("an ordinary huddle still gets the dock, and the stage when it was expanded", () => {
    // The other half of the rule: pinning the walkie's surface must not have
    // taken the stage away from the calls it belongs to.
    expect(surface(base, huddle)).toBe("dock");
    expect(surface(base, huddle, true)).toBe("stage");
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
    callsOn();
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

  test("calls off for this team refuses both the key and the door", () => {
    // The composer's mic used to render enabled with calls off, and pressing
    // it joined a room that threw — leaving the call plane in `error`, which
    // the ordinary dock does not bail on, so a floating call window opened out
    // of a chat composer. Both questions answer the same way now.
    callPlane({});
    callsOn(false);
    expect(walkieBlockedReason(ROOM)).toBe("Calls are not on for this team");
    expect(walkieJoinReason(ROOM)).toBe("Calls are not on for this team");
    callsOn(true);
    expect(walkieBlockedReason(ROOM)).toBe(null);
  });
});

// ct-44931 polish round 12. A burst whose finalize never landed carries no
// duration, and the clock rendered "0:00" beside its transcript — claiming a
// recording of no length rather than no recording at all, which the glyph
// beside it already says correctly.
describe("the clock only appears when there is something to time", () => {
  test("a burst with no duration shows no clock", () => {
    const html = render(view({ content: "the deploy is green", voice: { status: "done" } }));
    expect(html).toContain("the deploy is green");
    expect(html).toContain("ch-voice-noaudio");
    expect(html).not.toContain("0:00");
    expect(html).not.toContain("ch-voice-clock");
  });

  test("a burst with a real length still shows it", () => {
    const html = render(
      view({
        content: "shipping it",
        voice: { status: "done", durationMs: 7_400 },
        attachments: [{ storage_id: "st1", mime: "audio/webm" }],
      }),
    );
    expect(html).toContain("ch-voice-clock");
    expect(html).toContain("0:07");
  });
});

// ct-45855. The bubble gained three states the founder asked for by name — a
// meter while somebody is talking, a direction you can read without words, and
// an honest wait while the server recovers what the live recognizer missed —
// and one bug fix: a message carrying audio is a voice note whatever wrote it.

describe("the live bubble reads as a direction", () => {
  test("a burst you are not sending is the cool, incoming colour", () => {
    // No burst of our own is in flight in this process, so every live bubble
    // here is somebody else's voice arriving.
    const html = render(view({ content: "on my way", voice: { status: "live", roomKey: ROOM } }));
    expect(html).toContain("ch-voice-rx");
    expect(html).not.toContain("ch-voice-tx");
  });

  test("with no voice to measure, the dot carries it alone", () => {
    // A live burst in a DM somebody has open but is not in the room for has no
    // level on either side. Four bars sitting flat would say the microphone was
    // dead; the pulsing dot says only what is known, which is that a burst is
    // open.
    const html = render(view({ content: "hello", voice: { status: "live", roomKey: ROOM } }));
    expect(html).toContain("ch-voice-dot");
    expect(html).not.toContain("walkie-level");
  });
});

describe("while the server is recovering the words", () => {
  test("it says it is getting them, rather than showing a silence", () => {
    // The live recognizer came back empty and chat.transcribeVoiceNote is
    // reading the recording. An empty bubble beside a playable file reads as a
    // burst nobody could transcribe, when the words are seconds away.
    const html = render(
      view({
        voice: { status: "done", durationMs: 4_000, transcribing: true },
        attachments: [{ storage_id: "st1", mime: "audio/webm" }],
      }),
    );
    expect(html).toContain("getting the words");
    expect(html).toContain("ch-voice-spinner");
    expect(html).not.toContain("no words");
  });

  test("words that have landed win over the state that was waiting for them", () => {
    // The flag comes off in the same patch that writes the transcript, but the
    // two reach a client in whatever order the sync gives them. Whichever
    // arrives first, the words are the answer.
    const html = render(
      view({
        content: "the deploy is green",
        voice: { status: "done", durationMs: 4_000, transcribing: true },
      }),
    );
    expect(html).toContain("the deploy is green");
    expect(html).not.toContain("getting the words");
  });
});

describe("a message whose attachment is audio", () => {
  const row = (over: Record<string, unknown> = {}) =>
    toMessageView(
      {
        _id: MESSAGE,
        channel_id: CHANNEL,
        user_id: "u1",
        content: "",
        created_at: Date.now(),
        attachments: [{ storage_id: "st1", mime: "audio/webm" }],
        ...over,
      } as any,
      { members: new Map(), viewerId: "u1" } as any,
    );

  test("alone, and with nothing typed, it is a voice note", () => {
    // Diagnosis 7 of pl-431: the renderer keyed on `voice` rather than on what
    // was attached, so a recording that arrived any other way rendered as file
    // tiles — a storage id in an <img>, with no way to play it.
    const v = row();
    expect(v.voice?.status).toBe("done");
    expect(v.voice?.inferred).toBe(true);
    const html = render(v);
    expect(html).toContain(`data-walkie-play="${MESSAGE}"`);
    expect(html).not.toContain("ch-att");
  });

  test("an image attachment is still an image", () => {
    expect(row({ attachments: [{ storage_id: "st1", mime: "image/png" }] }).voice).toBeUndefined();
  });

  test("a real voice field is never overwritten by the guess", () => {
    const v = row({ voice: { status: "live", room_key: ROOM } });
    expect(v.voice?.status).toBe("live");
    expect(v.voice?.inferred).toBeUndefined();
  });

  // A voice bubble REPLACES the body — the markdown and the attachment grid
  // both — so guessing one for a row that carries anything else is a way to
  // make that something else disappear off the screen with no trace. These pin
  // that nothing vanishes in any combination.
  test("text plus a recording plus an image loses none of the three", () => {
    const v = row({
      content: "here is the **clip** I mentioned",
      attachments: [
        { storage_id: "st-audio", mime: "audio/webm" },
        { storage_id: "st-image", mime: "image/png" },
      ],
    });
    // Not a voice note: it is an ordinary message that happens to carry one.
    expect(v.voice).toBeUndefined();
    const html = render(v);
    // The text survives as markdown rather than as a transcript.
    expect(html).toContain("<strong>clip</strong>");
    // The image still reaches the grid, which is what silently vanished.
    expect(html).toContain("ch-att");
    // And the recording is playable rather than drawn as a broken thumbnail.
    expect(html).toContain(`data-walkie-play="${MESSAGE}:st-audio"`);
  });

  test("a recording beside typed words keeps the words as words", () => {
    const v = row({ content: "listen to this", attachments: [{ storage_id: "st-a", mime: "audio/webm" }] });
    expect(v.voice).toBeUndefined();
    const html = render(v);
    expect(html).toContain("listen to this");
    expect(html).toContain(`data-walkie-play="${MESSAGE}:st-a"`);
  });

  test("two recordings on one row get their own player keys", () => {
    // One audio element serves the whole app, so two recordings sharing a key
    // would fight over it: pressing the second would show the first as playing.
    const html = render(
      row({
        attachments: [
          { storage_id: "st-a", mime: "audio/webm" },
          { storage_id: "st-b", mime: "audio/webm" },
        ],
      }),
    );
    expect(html).toContain(`data-walkie-play="${MESSAGE}:st-a"`);
    expect(html).toContain(`data-walkie-play="${MESSAGE}:st-b"`);
  });
});

// The key's four states, which are four different claims about where the words
// are going. The middle two are the redesign: the microphone being open and a
// teammate hearing it are seconds apart on a cold room, and the key used to
// wait for the second before it lit — telling the person to start speaking at
// the one moment nothing was being kept.
describe("what the key is doing", () => {
  const ptt = (over: Record<string, boolean> = {}) => ({
    holding: false,
    capturing: false,
    dropped: false,
    ...over,
  });

  test("idle until the key goes down", () => {
    expect(walkieKeyState(ptt())).toBe("idle");
  });

  test("opening while the key is down and the microphone is not open yet", () => {
    expect(walkieKeyState(ptt({ holding: true }))).toBe("opening");
  });

  test("live the moment the microphone opens, whatever the room is doing", () => {
    // `capturing` is the engine's `sending.live`: recorder, meter and recognizer
    // running. It does NOT wait on `heardLive`, which is the room, because the
    // words are already being kept and that is what makes it worth speaking.
    expect(walkieKeyState(ptt({ holding: true, capturing: true }))).toBe("live");
  });

  test("dropped wins over everything: the mic is open and nobody is hearing it", () => {
    expect(walkieKeyState(ptt({ holding: true, capturing: true, dropped: true }))).toBe("dropped");
  });
});

// ── What the key is CALLED, for the sense that cannot see it ───────────────
//
// The eye reads the ring, the fill and the dot. A screen reader gets this
// string and nothing else, so it carries the state — and, when idle, WHICH
// key it is. A roster of twenty teammates draws twenty of these, and every one
// of them used to arrive as the identical "Hold to talk": the teammate's name
// was in `title`, where only a pointer could find it.
describe("walkieKeyName", () => {
  test("says why it cannot be held, over everything else", () => {
    expect(
      walkieKeyName("live", { reason: "You are in another call", live: true, title: "Hold to talk to Ann" }),
    ).toBe("You are in another call");
  });

  test("names each of the three moments of a hold", () => {
    expect(walkieKeyName("opening", {})).toBe("Opening the mic — do not talk yet");
    expect(walkieKeyName("live", { live: false })).toBe("Recording — they get it when you let go");
    expect(walkieKeyName("live", { live: true })).toBe("Live — they hear you now, keep holding to stay on");
    expect(walkieKeyName("dropped", {})).toBe("Nobody is hearing this — still recording");
    expect(walkieKeyName("locked", {})).toBe("You are live, hands free — End stops it");
  });

  test("names the person when idle, instead of twenty identical controls", () => {
    expect(walkieKeyName("idle", { title: "Hold to talk to Ann Diaz" })).toBe("Hold to talk to Ann Diaz");
    expect(walkieKeyName("idle", { title: "Hold to talk to Bo Chen" })).toBe("Hold to talk to Bo Chen");
  });

  test("keeps a visible label in the name, so heard contains seen", () => {
    expect(walkieKeyName("idle", { label: "Hold to reply", title: "Hold to reply" })).toBe("Hold to reply");
  });

  test("falls back to the gesture when a caller says nothing at all", () => {
    expect(walkieKeyName("idle", {})).toBe("Hold to talk");
  });
});

// ── The room going away under an open microphone ──────────────────────────
//
// Nothing in a burst is tied to the room's connection state, and
// `sending.heardLive` only ever says the track reached the room ONCE. So a
// LiveKit disconnect mid-hold left the engine's `sending` untouched while the
// call plane correctly went idle, and the strip went on saying "Live to Jordan
// Lee" to somebody whose voice was reaching nobody.
//
// The key and the strip now ask this one function, so they cannot drift.
describe("walkieBurstDropped", () => {
  const burst = { openAt: 1000, roomKey: "dm:a:b" };

  test("is false while the client is seated in the burst's room", () => {
    expect(walkieBurstDropped(burst, { roomKey: "dm:a:b", phase: "connected" })).toBe(false);
    // Connecting counts: the track is on its way and nothing has been lost.
    expect(walkieBurstDropped(burst, { roomKey: "dm:a:b", phase: "connecting" })).toBe(false);
  });

  test("is true once the call plane leaves that room", () => {
    expect(walkieBurstDropped(burst, { roomKey: null, phase: "idle" })).toBe(true);
    // Or lands somewhere else entirely.
    expect(walkieBurstDropped(burst, { roomKey: "dm:a:c", phase: "connected" })).toBe(true);
  });

  test("is false before the track ever reached the room", () => {
    // Nothing has dropped yet — this is the ordinary opening window, and
    // calling it a drop would report a failure where there is only a wait.
    expect(walkieBurstDropped({ openAt: null, roomKey: "dm:a:b" }, { roomKey: null, phase: "idle" })).toBe(false);
  });

  test("is false when there is no burst at all", () => {
    expect(walkieBurstDropped(null, { roomKey: null, phase: "idle" })).toBe(false);
  });
});
