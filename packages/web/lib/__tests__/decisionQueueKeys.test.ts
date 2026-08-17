import { describe, expect, test } from "bun:test";
import { routeQueueKey } from "../decisionQueue";

// The decision card's key listener runs on window in CAPTURE phase, so every
// key in the app passes through it first. These tests pin the stand-down
// rules — the regression that motivated them: with the queue open behind the
// new-session compose dialog, the card claimed Enter typed in the dialog's
// composer (preventDefault + stopPropagation), so sending a message looked
// completely dead ("enter stopped working").

const key = (k: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

const ctx = (over: Partial<Parameters<typeof routeQueueKey>[1]> = {}) => ({
  modalOpen: false,
  editing: false,
  inOwnFreeTextBox: false,
  isPermissionCard: false,
  optionCount: 3,
  sheet: "full" as const,
  ...over,
});

describe("stand-down: a modal above the queue owns the keyboard", () => {
  test("Enter in the compose dialog's composer is never claimed", () => {
    expect(routeQueueKey(key("Enter"), ctx({ modalOpen: true, editing: true }))).toBeNull();
  });
  test("Escape under a modal is never claimed", () => {
    expect(routeQueueKey(key("Escape"), ctx({ modalOpen: true }))).toBeNull();
  });
  test("digits under a modal cannot answer the decision behind it", () => {
    expect(routeQueueKey(key("1"), ctx({ modalOpen: true }))).toBeNull();
  });
});

describe("stand-down: inputs that are not the card's own box", () => {
  test("Enter typed in some other input belongs to that surface", () => {
    expect(routeQueueKey(key("Enter"), ctx({ editing: true, inOwnFreeTextBox: false }))).toBeNull();
  });
  test("Escape typed in some other input belongs to that surface", () => {
    expect(routeQueueKey(key("Escape"), ctx({ editing: true, inOwnFreeTextBox: false }))).toBeNull();
  });
});

describe("the card's own free-text box", () => {
  test("Enter commits the answer", () => {
    expect(routeQueueKey(key("Enter"), ctx({ editing: true, inOwnFreeTextBox: true }))).toEqual({ kind: "commit-free-text" });
  });
  test("Shift+Enter stays a newline", () => {
    expect(routeQueueKey(key("Enter", { shiftKey: true }), ctx({ editing: true, inOwnFreeTextBox: true }))).toBeNull();
  });
  test("Escape closes the box", () => {
    expect(routeQueueKey(key("Escape"), ctx({ editing: true, inOwnFreeTextBox: true }))).toEqual({ kind: "close-free-text" });
  });
});

describe("queue keys at rest (no modal, not editing)", () => {
  test("digit answers the matching option", () => {
    expect(routeQueueKey(key("2"), ctx())).toEqual({ kind: "answer", option: 1 });
  });
  test("digit beyond the option list is not claimed", () => {
    expect(routeQueueKey(key("9"), ctx({ optionCount: 3 }))).toBeNull();
  });
  test("digits never answer a permission card", () => {
    expect(routeQueueKey(key("1"), ctx({ isPermissionCard: true }))).toBeNull();
  });
  test("o opens the session, s skips, t opens free text", () => {
    expect(routeQueueKey(key("o"), ctx())).toEqual({ kind: "open-session" });
    expect(routeQueueKey(key("s"), ctx())).toEqual({ kind: "skip" });
    expect(routeQueueKey(key("t"), ctx())).toEqual({ kind: "open-free-text" });
  });
  test("Escape exits from full but first restores the question from peek", () => {
    expect(routeQueueKey(key("Escape"), ctx({ sheet: "full" }))).toEqual({ kind: "exit-queue" });
    expect(routeQueueKey(key("Escape"), ctx({ sheet: "peek" }))).toEqual({ kind: "restore-question" });
  });
  test("modified chords are left for the shortcut layer", () => {
    expect(routeQueueKey(key("1", { metaKey: true }), ctx())).toBeNull();
    expect(routeQueueKey(key("s", { ctrlKey: true }), ctx())).toBeNull();
  });
});
