import { beforeEach, describe, expect, mock, test } from "bun:test";

// Where the person is, what the stage accepts, and every way out of actions.ts.
let path = "/files";
let stageOpens = false;
const calls: string[] = [];

mock.module("../../../stage", () => ({
  sessionPanePath: (id: string, msg?: string | null) => `/conversation/${id}${msg ? `#msg-${msg}` : ""}`,
  openBeside: (p: string) => { calls.push(`beside ${p}`); return stageOpens; },
}));
mock.module("../../../openSessionAtMessage", () => ({
  isOnThreadRoute: () => path === "/inbox" || path.startsWith("/conversation/"),
  openSessionAtMessage: (id: string, msg?: string | null) => { calls.push(`store ${id} ${msg ?? "-"}`); },
}));
mock.module("../../../openIntent", () => ({
  navigateHere: (p: string) => { calls.push(`go ${p}`); },
}));

const { openBlameSession, openConversationHere } = await import("../actions");

const session = { conversation_id: "c1", message_id: "m1" } as never;
const noMessage = { conversation_id: "c1" } as never;

beforeEach(() => { calls.length = 0; path = "/files"; stageOpens = false; });

describe("blame actions", () => {
  test("the bar opens the session beside the editor, at the message that made the edit", () => {
    stageOpens = true;
    expect(openBlameSession(session)).toBe(true);
    expect(calls).toEqual(["beside /conversation/c1#msg-m1"]);
    calls.length = 0;
    openBlameSession(noMessage);
    expect(calls).toEqual(["beside /conversation/c1"]);
  });

  test("with no room beside, the bar opens the conversation in the main view at the message", () => {
    openBlameSession(session);
    expect(calls).toEqual(["beside /conversation/c1#msg-m1", "go /conversation/c1#msg-m1"]);
  });

  test("nothing to open without a conversation", () => {
    expect(openBlameSession(undefined)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("with no message id, the main view opens the conversation itself", () => {
    openConversationHere("c1", null);
    path = "/conversation/c2";
    openConversationHere("c1", undefined);
    expect(calls).toEqual(["go /conversation/c1", "store c1 -"]);
  });
});
