import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GuestOutcome, type Outcome } from "./GuestOutcome";
import { GuestLobby, deviceTrouble, type LobbyMode } from "./GuestLobby";
import { CallNotice } from "./MeetChrome";
import { GuestInCall } from "./GuestInCall";

// The guest's screens, drawn from their props alone: what each one says and
// offers. The media and the server are not here; the page's own state machine
// decides which screen is up (page.tsx), these decide what it reads like.

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function outcome(o: Outcome) {
  return text(renderToStaticMarkup(<GuestOutcome outcome={o} onAskAgain={() => {}} busy={false} error={null} />));
}

const view = (v: any, over: Partial<Extract<Outcome, { kind: "view" }>> = {}): Outcome => ({
  kind: "view",
  view: v,
  leftReason: null,
  retryAt: null,
  canAskAgain: true,
  ...over,
});

describe("the end of the road, in plain words", () => {
  test("a link that does not work says why and offers nothing", () => {
    const t = outcome({ kind: "refused", reason: "expired" });
    expect(t).toContain("This link has expired");
    expect(t).toContain("Ask whoever sent it for a new one");
    expect(t).not.toContain("Ask again");
    // Said once, in the heading: the body under it is what to do next.
    expect(t.split("This link has expired").length - 1).toBe(1);
    // A reason the heading does not carry is still explained.
    expect(outcome({ kind: "refused", reason: "inviter_gone" })).toContain("can no longer invite guests");
  });

  test("turned away: a countdown, then Ask again", () => {
    expect(outcome(view("denied", { retryAt: Date.now() + 42_000 }))).toMatch(/ask again in 4\ds\./);
    expect(outcome(view("denied", { retryAt: Date.now() - 600_000 }))).toContain("You can ask again now");
  });

  test("removed is final, and promises only what the server enforces", () => {
    const t = outcome(view("removed", { canAskAgain: true }));
    expect(t).toContain("You were removed from the call");
    expect(t).not.toContain("Rejoin");
    expect(t).not.toContain("This link no longer works");
    expect(outcome(view("removed", { canAskAgain: false }))).toContain("This link no longer works");
  });

  test("a place let go without anybody deciding it says which, and walks back in while it is held", () => {
    const dropped = outcome(view("left", { leftReason: "lapsed", resumable: true }));
    expect(dropped).toContain("You were disconnected");
    expect(dropped).toContain("Your place is still held");
    expect(dropped).toContain("Rejoin");
    const never = outcome(view("left", { leftReason: "not_joined", resumable: true }));
    expect(never).toContain("You didn't join in time");
    expect(never).not.toContain("lost touch");
    expect(never).toContain("Join now");
    expect(outcome(view("left", { leftReason: "not_joined", resumable: false }))).toContain("Ask to join again");
  });

  test("a browser that cannot hold a call is told where to open the link, and offered no knock", () => {
    const t = outcome({ kind: "unsupported" });
    expect(t).toContain("This browser can't join calls");
    expect(t).toContain("Safari, Chrome, Firefox or Edge");
    expect(t).toContain("Copy link");
    expect(t).not.toContain("Ask");
  });

  test("a page that cannot reach the call offers another try, not a reload", () => {
    const t = outcome({ kind: "unreachable" });
    expect(t).toContain("Couldn't reach the call");
    expect(t).toContain("Try again");
    expect(t).not.toContain("Reload");
  });

  test("the way back in waits while the page is still telling the server about a Leave", () => {
    const html = (o: Outcome) => renderToStaticMarkup(<GuestOutcome outcome={o} onAskAgain={() => {}} busy={false} error={null} />);
    expect(html(view("left", { leftReason: "self", pending: true }))).toMatch(/<button type="button" disabled=""/);
    expect(html(view("left", { leftReason: "self" }))).not.toMatch(/<button type="button" disabled=""/);
  });

  test("leaving, being dropped and the call ending each say which, with the way back only while the link works", () => {
    expect(outcome(view("left", { leftReason: "self" }))).toContain("Rejoin");
    expect(outcome(view("left", { leftReason: "self", canAskAgain: false }))).not.toContain("Rejoin");
    expect(outcome(view("left", { leftReason: "lapsed" }))).toContain("You were disconnected");
    expect(outcome(view("ended"))).toContain("The call has ended");
    expect(outcome(view("closed", { reason: "revoked" }))).toContain("This link was turned off");
  });
});

describe("the notice before joining", () => {
  const notice = (transcribed: boolean, recording: boolean) =>
    text(renderToStaticMarkup(<CallNotice transcribed={transcribed} recording={recording} />));

  test("says what is kept, and says so when nothing is", () => {
    expect(notice(true, false)).toContain("This call is transcribed");
    expect(notice(true, false)).not.toContain("recorded");
    expect(notice(true, true)).toContain("being recorded, video and screen shares included");
    expect(notice(false, false)).toContain("not being transcribed or recorded");
  });
});

describe("the lobby and the door", () => {
  const preview = {
    subscribe: () => () => {},
    getSnapshot: () => ({
      video: null,
      audio: null,
      cameraError: null,
      micError: null,
      cameraDenied: false,
      micDenied: false,
      asking: false,
      devices: { mic: [], camera: [], speaker: [] },
      choice: {},
    }),
    level: () => 0,
    subscribeLevel: () => () => {},
    start: async () => {},
    choose: async () => {},
    setMic: async () => {},
    setCamera: async () => {},
  } as any;

  const lobby = (mode: LobbyMode, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <GuestLobby
        preview={preview}
        mode={mode}
        title="#design"
        inviter={{ name: "Sam Lee" }}
        live
        transcribed
        recording={false}
        name="Ada"
        onName={() => {}}
        onAsk={() => {}}
        onCancel={() => {}}
        onJoin={() => {}}
        onLeave={() => {}}
        onToggle={() => {}}
        busy={false}
        error={null}
        waitingSince={null}
        accepted={null}
        creatorTold={false}
        doorFull={false}
        heldUntil={null}
        signedIn={false}
        {...over}
      />,
    );

  test("asking: the meeting, who invited, the notice, and Ask to join", () => {
    const t = text(lobby("ask"));
    expect(t).toContain("You're invited to");
    expect(t).toContain("#design");
    expect(t).toContain("Sam Lee invited you");
    expect(t).toContain("live now");
    expect(t).toContain("This call is transcribed");
    expect(t).toContain("Ask to join");
  });

  test("no name, no knock", () => {
    expect(lobby("ask", { name: "  " })).toMatch(/<button type="submit" disabled=""/);
  });

  test("waiting says who knows they are there, live or not", () => {
    expect(text(lobby("waiting"))).toContain("Someone in the call will let you in");
    // "We let Sam know" only when somebody actually sent word.
    expect(text(lobby("waiting", { live: false, creatorTold: true }))).toContain("We let Sam know you're here");
    expect(text(lobby("waiting", { live: false }))).not.toContain("Sam know");
    expect(text(lobby("waiting", { live: false }))).toContain("Someone can let you in once the call starts");
    expect(text(lobby("waiting"))).toContain("stop asking");
  });

  test("a page that came back to a full door says so and keeps trying", () => {
    const t = text(lobby("waiting", { doorFull: true }));
    expect(t).toContain("Lots of people are waiting");
    expect(t).toContain("Keep this page open");
    expect(t).not.toContain("Someone in the call will let you in");
    // Not in line, and nobody inside can see them: no minutes, no knocking ring.
    expect(t).toContain("waiting for a place at the door");
    expect(t).not.toContain("waiting less than a minute");
    const html = lobby("waiting", { doorFull: true });
    expect(html).not.toContain("meet-knock-ring");
    expect(lobby("waiting")).toContain("meet-knock-ring");
  });

  test("let in but not yet back in the room: one press to join, and one to say no", () => {
    const t = text(lobby("rejoin"));
    expect(t).toContain("You've been let in to");
    expect(t).not.toContain("You're in");
    expect(t).toContain("Join the call");
    expect(t).toContain("Don't join");
  });

  test("while the browser's prompt is up the two switches rest, and are not drawn as off", () => {
    const asking = { ...preview, getSnapshot: () => ({ ...preview.getSnapshot(), asking: true }) };
    const html = lobby("ask", { preview: asking });
    expect(html.match(/disabled="" class="[^"]*bg-white\/10 text-white\/50/g)?.length).toBe(2);
    expect(html).not.toContain("bg-sol-red/85");
    expect(lobby("ask")).toContain("bg-sol-red/85");
  });

  test("device trouble names the real problem, and a guest with no microphone is told they can listen", () => {
    const both = { micError: "Microphone permission denied", cameraError: "Camera permission denied" };
    expect(deviceTrouble({ ...both, micDenied: true, cameraDenied: true })).toContain("Allow them from the icon in the address bar");
    const none = deviceTrouble({ micError: "No microphone found", cameraError: "No camera found", micDenied: false, cameraDenied: false });
    expect(none).toBe("No microphone found. No camera found. You can still join and listen.");
    expect(none).not.toContain("address bar");
    expect(deviceTrouble({ micError: "No microphone found", cameraError: null, micDenied: false, cameraDenied: false })).toContain("join and listen");
    expect(deviceTrouble({ micError: null, cameraError: "No camera found", micDenied: false, cameraDenied: false })).toBe("No camera found. You can still join without it.");
  });

  test("while the browser's prompt is up, Join waits for it rather than joining without devices", () => {
    const asking = { ...preview, getSnapshot: () => ({ ...preview.getSnapshot(), asking: true }) };
    const html = lobby("rejoin", { preview: asking });
    expect(text(html)).toContain("Waiting for your camera and microphone");
    expect(html).toMatch(/<button type="button" disabled=""/);
  });

  test("a place held for them while they read says for how long", () => {
    expect(text(lobby("rejoin", { heldUntil: Date.now() + 4 * 60_000 + 10_000 }))).toContain("your place is held for 5 min");
    // A plain reload holds it a minute, and says that too.
    expect(text(lobby("rejoin", { heldUntil: Date.now() + 55_000 }))).toContain("your place is held for about a minute");
    expect(text(lobby("rejoin"))).not.toContain("your place is held");
  });

  test("a recording that started while they waited is told at the door and marked new", () => {
    const t = text(lobby("waiting", { recording: true, accepted: { recording: false, transcribed: true } }));
    expect(t).toContain("Started while you waited.");
    expect(t).toContain("being recorded");
    // Let in meanwhile: the lobby says joining is theirs to choose.
    const r = text(lobby("rejoin", { recording: true, accepted: { recording: false, transcribed: true } }));
    expect(r).toContain("joining is yours to choose");
    // The choice is explicit: join under what it keeps now, or walk out.
    expect(r).toContain("Join, recorded");
    expect(r).toContain("Leave");
    expect(r).not.toContain("Don't join");
  });

  test("a signed-in browser is pointed at the app, to join as themselves", () => {
    expect(text(lobby("ask", { signedIn: true }))).toContain("Join as yourself, not as a guest: open codecast and join from Live now in the sidebar");
    expect(text(lobby("ask"))).not.toContain("as yourself");
  });
});

describe("inside the call", () => {
  // A GuestCall as the screen reads it: a snapshot store and a room.
  const fakeCall = (over: Record<string, unknown> = {}) => {
    const snap = {
      phase: "connected",
      ended: null,
      people: [
        { identity: "guest:g1", name: "Ada", kind: "guest", isLocal: true, muted: false, sharing: false },
        { identity: "u1", name: "Sam Lee", kind: "person", isLocal: false, muted: true, sharing: false },
      ],
      tiles: [],
      speaking: [],
      mic: true,
      camera: true,
      sharing: false,
      wants: { mic: true, camera: true },
      devices: { mic: [], camera: [], speaker: [] },
      audioBlocked: false,
      error: null,
      choice: {},
      ...over,
    };
    return { subscribe: () => () => {}, getSnapshot: () => snap, getRoom: () => null, refreshDevices: async () => {} } as any;
  };
  const inCall = (call: any, over: Record<string, unknown> = {}) =>
    text(
      renderToStaticMarkup(
        <GuestInCall
          call={call}
          title="#design"
          myName="Ada"
          transcribed
          recording={false}
          accepted={null}
          reconnecting={false}
          serverTrouble={false}
          onLeave={() => {}}
          onReconnect={() => {}}
          onStopRecording={async () => {}}
          {...over}
        />,
      ),
    );

  test("my own row reads 'you', never my name with a guest mark", () => {
    const t = inCall(fakeCall());
    expect(t).toContain("you");
    expect(t).not.toContain("Ada guest");
  });

  test("every way the media lets go is said, with what to do", () => {
    expect(inCall(fakeCall({ phase: "disconnected", ended: "lost" }))).toContain("You lost the connection to the call. Reconnect");
    expect(inCall(fakeCall({ phase: "disconnected", ended: "removed" }))).toContain("You were removed from the call.");
    expect(inCall(fakeCall({ phase: "disconnected", ended: "room_closed" }))).toContain("The call has ended.");
    expect(inCall(fakeCall({ phase: "disconnected", ended: "elsewhere" }))).toContain("You joined this call from another tab or window. Use this tab");
  });

  test("the page's reading of the ending overrules the media's: a closed room the server still admits into is a lost line", () => {
    const t = inCall(fakeCall({ phase: "disconnected", ended: "room_closed" }), { ended: "lost" });
    expect(t).toContain("You lost the connection to the call.");
    expect(t).not.toContain("The call has ended.");
  });

  test("losing touch with the server is a line, not the end of the call", () => {
    const t = inCall(fakeCall(), { serverTrouble: true });
    expect(t).toContain("The call itself is still connected");
    expect(t).toContain("leave");
  });

  test("a recording they did not join under is said in words on the way in, with what they can do", () => {
    const t = inCall(fakeCall(), { recording: true, accepted: { recording: false, transcribed: true } });
    expect(t).toContain("This call is being recorded, video and screen shares included.");
    expect(t).toContain("Turn camera off");
    expect(t).toContain("Stop recording");
    // Joined under it: the mark in the bar, no line.
    expect(inCall(fakeCall(), { recording: true, accepted: { recording: true, transcribed: true } })).not.toContain("Turn camera off");
  });

  test("a transcript they did not join under is said in words too, with a way to mute", () => {
    const t = inCall(fakeCall(), { transcribed: true, accepted: { recording: false, transcribed: false } });
    expect(t).toContain("This call is transcribed: what everyone says is written down.");
    expect(t).toContain("Mute");
    expect(inCall(fakeCall(), { transcribed: true, accepted: { recording: false, transcribed: true } })).not.toContain("written down.");
  });

  test("an agent's face is counted and marked apart from the people", () => {
    const t = inCall(
      fakeCall({
        people: [
          { identity: "guest:g1", name: "Ada", kind: "guest", isLocal: true, muted: false, sharing: false },
          { identity: "u1", name: "Sam Lee", kind: "person", isLocal: false, muted: true, sharing: false },
          { identity: "agent:c9", name: "Claude", kind: "agent", isLocal: false, muted: false, sharing: false },
        ],
      }),
      { accepted: { recording: false, transcribed: true } },
    );
    expect(t).toContain("2 · 1 agent");
    expect(t).toContain("Claude agent");
  });

  test("let in while away: said, with the way to turn the devices on", () => {
    const t = inCall(fakeCall({ mic: false, camera: false }), { awayNotice: true, accepted: { recording: false, transcribed: true } });
    expect(t).toContain("You were let in while you were away, so you joined with your microphone and camera off.");
    expect(t).toContain("Unmute");
    expect(t).toContain("Turn camera on");
  });

  test("the device switches rest whenever the media is not connected", () => {
    const html = (phase: string) =>
      renderToStaticMarkup(
        <GuestInCall
          call={fakeCall({ phase })}
          title="#design"
          myName="Ada"
          transcribed
          recording={false}
          accepted={{ recording: false, transcribed: true }}
          reconnecting={false}
          serverTrouble={false}
          onLeave={() => {}}
          onReconnect={() => {}}
          onStopRecording={async () => {}}
        />,
      );
    expect(html("connected")).not.toContain('disabled=""');
    for (const phase of ["connecting", "reconnecting", "disconnected"]) {
      expect(html(phase).match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("a reconnect the page is making keeps the stage, under its line", () => {
    const t = inCall(fakeCall({ phase: "connecting", people: [] }), { reconnecting: true, accepted: { recording: false, transcribed: true } });
    expect(t).toContain("Reconnecting");
    expect(t).toContain("reconnecting…");
  });
});
