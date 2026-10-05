import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GuestNotice } from "@codecast/shared/contracts";

// Mounted, not rendered to a string: what is under test is a press. Putting
// away the line about a recording that started inside is the guest agreeing
// to it (callGuests.acceptGuestNotice keeps it, and their next reconnect is
// let through, callGuests.test.ts), while the banner's other presses are
// choices about the news and agree to nothing.
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/meet/x", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { GuestInCall } = await import("./GuestInCall");

const fakeCall = () => {
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
  };
  const calls: string[] = [];
  return {
    calls,
    call: {
      subscribe: () => () => {},
      getSnapshot: () => snap,
      getRoom: () => null,
      refreshDevices: async () => {},
      setCamera: async (on: boolean) => void calls.push(`camera:${on}`),
      setMic: async (on: boolean) => void calls.push(`mic:${on}`),
    } as any,
  };
};

let root: Root;
beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
});
afterEach(() => act(() => root.unmount()));

const mount = async (call: any, agreed: GuestNotice[], over: Record<string, unknown> = {}) =>
  act(async () =>
    root.render(
      <GuestInCall
        call={call}
        title="#design"
        myName="Ada"
        transcribed
        recording
        accepted={{ recording: false, transcribed: true }}
        reconnecting={false}
        serverTrouble={false}
        onLeave={() => {}}
        onReconnect={() => {}}
        onStopRecording={async () => {}}
        onAgree={(n) => agreed.push(n)}
        {...over}
      />,
    ),
  );
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;
const press = (label: string) => act(async () => button(label)!.click());

describe("a guest told of a recording that started inside", () => {
  test("putting the line away agrees to the room as it is now", async () => {
    const { call } = fakeCall();
    const agreed: GuestNotice[] = [];
    await mount(call, agreed);
    expect(document.body.textContent).toContain("This call is being recorded");
    await press("Dismiss");
    expect(agreed).toEqual([{ recording: true, transcribed: true, video_public: false, words_public: false }]);
    expect(document.body.textContent).not.toContain("This call is being recorded");
  });

  test("turning the camera off or asking to stop is a choice, not agreement", async () => {
    const { call, calls } = fakeCall();
    const agreed: GuestNotice[] = [];
    await mount(call, agreed);
    await press("Turn camera off");
    await press("Stop recording");
    expect(calls).toEqual(["camera:false"]);
    expect(agreed).toEqual([]);
  });

  test("a transcript line put away agrees to the words, and not to a recording still unread", async () => {
    const { call } = fakeCall();
    const agreed: GuestNotice[] = [];
    await mount(call, agreed, { accepted: { recording: false, transcribed: false } });
    const dismissals = [...document.querySelectorAll("button[aria-label='Dismiss']")] as HTMLButtonElement[];
    expect(dismissals.length).toBe(2);
    // The second line is the transcript's (guestNoticeLines puts the recording first).
    await act(async () => dismissals[1].click());
    expect(agreed).toEqual([{ recording: false, transcribed: true, video_public: false, words_public: false }]);
  });
});
