import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { boardButtonRoom, callBoardRoute } from "./callBoardRoute";

// The phone never opens a codecast web page (root CLAUDE.md): the call's
// board, its banners and Scribe all stay on native screens.
const FILES = [
  "app/call-board.tsx",
  "components/calls/CallBoardButton.tsx",
  "components/calls/BoardColumn.tsx",
  "components/calls/PhoneAutoScribe.tsx",
  "lib/calls/boardColumn.ts",
];
const WEB_OPENERS = /openWebPage|openInAppBrowser|openInBrowser|openLink\(|expo-web-browser|Linking\.openURL|codecast\.sh|https?:\/\//;

describe("the call board stays native", () => {
  test("the Board button opens the native board screen", () => {
    expect(callBoardRoute("room-1")).toEqual({ pathname: "/call-board", params: { room: "room-1" } });
    const button = readFileSync(`${import.meta.dir}/../../components/calls/CallBoardButton.tsx`, "utf8");
    expect(button).toContain("router.push(callBoardRoute(room)");
  });

  test("the call screen mounts the Board button", () => {
    const call = readFileSync(`${import.meta.dir}/../../app/call.tsx`, "utf8");
    expect(call).toContain("<CallBoardButton phase={call.phase} roomKey={call.roomKey} />");
  });

  test("the Board button shows only in a connected call with a live transcript", () => {
    expect(boardButtonRoom("connected", "channel:a", { transcript_id: "t1" })).toBe("channel:a");
    // A phone-only huddle nobody transcribes has no board to open.
    expect(boardButtonRoom("connected", "channel:a", null)).toBeNull();
    expect(boardButtonRoom("connected", "channel:a", undefined)).toBeNull();
    expect(boardButtonRoom("connecting", "channel:a", { transcript_id: "t1" })).toBeNull();
    expect(boardButtonRoom("connected", null, { transcript_id: "t1" })).toBeNull();
  });
});

// One rule for both apps: the phone's banners and Scribe come from web's
// lib/calls/huddleSettings and useScribe, never a phone copy.
describe("the phone board's banners and Scribe are web's", () => {
  const screen = readFileSync(`${import.meta.dir}/../../app/call-board.tsx`, "utf8");
  test("banner state, once-per-workspace Next time and the invite words", () => {
    expect(screen).toContain("boardBannerState({ present: scribe.present, memo, boardViewOn, autoScribeOn, nextSeen })");
    expect(screen).toContain("useNextTimeSeen(workspace)");
    expect(screen).toContain("markNextTimeSeen(workspace)");
    expect(screen).toContain("{SCRIBE_INVITE_WORDS}");
  });
  test("Next time follows only an invite that seated Scribe", () => {
    expect(screen).toContain("scribe.invite().then((ok) => ok && noteBanner(callKey, { invited: true }))");
  });
  test("invite and remove are web's useScribe, auto-invite web's rule", () => {
    expect(screen).toContain("useScribe(roomKey, live, appAlert)");
    const auto = readFileSync(`${import.meta.dir}/../../components/calls/PhoneAutoScribe.tsx`, "utf8");
    expect(auto).toContain("useAutoScribe(call.phase === 'connected' ? call.roomKey : null, appAlert)");
    const layout = readFileSync(`${import.meta.dir}/../../app/_layout.tsx`, "utf8");
    expect(layout).toContain("<PhoneAutoScribe />");
  });

  for (const f of FILES) {
    test(`${f} opens no web page`, () => {
      const src = readFileSync(`${import.meta.dir}/../../${f}`, "utf8");
      expect(src.match(WEB_OPENERS)?.[0] ?? null).toBeNull();
    });
  }
});
