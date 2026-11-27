import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { callBoardRoute } from "./callBoardRoute";

// The phone never opens a codecast web page (root CLAUDE.md): the call's
// board, its banners and Scribe all stay on native screens.
const FILES = [
  "app/call-board.tsx",
  "components/calls/CallBoardButton.tsx",
  "components/calls/BoardColumn.tsx",
  "lib/calls/usePhoneScribe.ts",
  "lib/calls/boardColumn.ts",
  "lib/calls/huddleBanner.ts",
];
const WEB_OPENERS = /openWebPage|openInAppBrowser|openInBrowser|openLink\(|expo-web-browser|Linking\.openURL|codecast\.sh|https?:\/\//;

describe("the call board stays native", () => {
  test("the Board button opens the native board screen", () => {
    expect(callBoardRoute("room-1")).toEqual({ pathname: "/call-board", params: { room: "room-1" } });
    const button = readFileSync(`${import.meta.dir}/../../components/calls/CallBoardButton.tsx`, "utf8");
    expect(button).toContain("router.push(callBoardRoute(roomKey)");
  });

  test("the call screen mounts the Board button", () => {
    const call = readFileSync(`${import.meta.dir}/../../app/call.tsx`, "utf8");
    expect(call).toContain("<CallBoardButton roomKey=");
  });

  for (const f of FILES) {
    test(`${f} opens no web page`, () => {
      const src = readFileSync(`${import.meta.dir}/../../${f}`, "utf8");
      expect(src.match(WEB_OPENERS)?.[0] ?? null).toBeNull();
    });
  }
});
