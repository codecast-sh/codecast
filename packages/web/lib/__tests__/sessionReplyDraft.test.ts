import { describe, expect, test } from "bun:test";
import { extractMentionHandles, SESSION_SHORT_ID_RE } from "@codecast/shared/chat";
import { draftSessions, draftSessionsKey, parseDraftSessionsKey, sessionReference, setSessionAsk } from "../sessionReplyDraft";

const serverWakes = (text: string) => extractMentionHandles(text).filter((h) => SESSION_SHORT_ID_RE.test(h));
const draftWakes = (text: string) => draftSessions(text).filter((s) => s.asks).map((s) => s.id);

describe("draftSessions", () => {
  test("reads every form, in order, once each", () => {
    expect(draftSessions("see @[Cam Broker jx7abcd] and jx7efgh, then @jx7ijkl do it; again jx7abcd")).toEqual([
      { id: "jx7abcd", asks: false },
      { id: "jx7efgh", asks: false },
      { id: "jx7ijkl", asks: true },
    ]);
  });

  test("a session named both ways asks", () => {
    expect(draftSessions("@[Cam jx7abcd] — @jx7abcd what next?")).toEqual([{ id: "jx7abcd", asks: true }]);
  });

  test("not a session: longer tokens, urls, emails", () => {
    expect(draftSessions("jx7abcdef @jx7abcd-x https://x.dev/@jx7abcd a@jx7abcd")).toEqual([]);
  });

  for (const text of [
    "@jx7abcd hi",
    "hi @JX7ABCD.",
    "(@jx7abcd)",
    "@[Title jx7abcd] only a reference",
    "jx7abcd bare",
    "mail a@jx7abcd",
    "path /@jx7abcd",
    "@jx7abcd-y",
    "@jx7abcde",
    "@[A jx7aaaaa] @jx7bbbbb and @jx7ccccc",
  ]) {
    test(`agrees with the server on what wakes: ${text}`, () => {
      expect(draftWakes(text)).toEqual(serverWakes(text));
    });
  }
});

describe("setSessionAsk", () => {
  test("on: the first reference becomes the address", () => {
    expect(setSessionAsk("ping @[Cam Broker jx7abcd] about jx7abcd", "jx7abcd", true)).toBe("ping @jx7abcd about jx7abcd");
  });

  test("on: already asking changes nothing", () => {
    const text = "@[Cam jx7abcd] and @jx7abcd";
    expect(setSessionAsk(text, "jx7abcd", true)).toBe(text);
  });

  test("off: every address becomes the titled reference", () => {
    expect(setSessionAsk("@jx7abcd look, @jx7abcd", "jx7abcd", false, "Manual Drive Cam Broker")).toBe(
      "@[Manual Drive Cam Broker jx7abcd] look, @[Manual Drive Cam Broker jx7abcd]",
    );
  });

  test("off without a title leaves the bare id", () => {
    expect(setSessionAsk("@jx7abcd look", "jx7abcd", false)).toBe("jx7abcd look");
  });

  test("round trip leaves other sessions alone", () => {
    const text = "@[Cam jx7abcd] vs @jx7efgh";
    const on = setSessionAsk(text, "jx7abcd", true);
    expect(draftWakes(on)).toEqual(["jx7abcd", "jx7efgh"]);
    expect(setSessionAsk(on, "jx7abcd", false, "Cam")).toBe(text);
  });
});

test("sessionReference clips long titles and strips brackets", () => {
  expect(sessionReference("jx7abcd", "A [very] long title that keeps going on")).toBe("@[A very long title that keeps g... jx7abcd]");
});

test("the key round-trips", () => {
  const text = "@[Cam jx7abcd] @jx7efgh";
  expect(parseDraftSessionsKey(draftSessionsKey(text))).toEqual(draftSessions(text));
  expect(parseDraftSessionsKey(draftSessionsKey("nothing"))).toEqual([]);
});
