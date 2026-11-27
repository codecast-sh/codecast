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
  test("the banners are web's hook, fed the same inputs as web's", () => {
    const web = readFileSync(`${import.meta.dir}/../../../web/components/calls/HuddleBoard.tsx`, "utf8");
    const stage = readFileSync(`${import.meta.dir}/../../../web/components/calls/CallStage.tsx`, "utf8");
    for (const src of [screen, web]) {
      expect(src).toContain("useBoardBanner(callKey, workspace, scribe)");
      expect(src).toContain("useMountEffect(banner.shown)");
      expect(src).toContain("banner.needsReview(autoScribe)");
      // No memo of its own: what the person did with the banners is the store's.
      expect(src).not.toMatch(/new Map<string, BannerMemo>|boardBannerState\(/);
    }
    expect(screen).toContain("<BoardBanner callKey={live.transcript_id} workspace={workspace}");
    expect(stage).toContain("<BoardBanner callKey={live.transcript_id} workspace={workspace}");
    expect(screen).toContain("{SCRIBE_INVITE_WORDS}");
  });
  test("colors come from the theme", () => {
    expect(screen.match(/['"]#[0-9a-fA-F]{3,8}['"]/)?.[0] ?? null).toBeNull();
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
