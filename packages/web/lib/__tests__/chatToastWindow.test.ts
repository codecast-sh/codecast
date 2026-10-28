import { expect, test } from "bun:test";
import { chatToastWindowOwns, type ChatToastWindowFacts } from "../chatToastWindow";

const base: ChatToastWindowFacts = {
  chatWindowOpen: false, isChatWindow: false, desktop: true,
  focused: false, appFocused: false, isMainWindow: false,
};
const owners = (windows: Partial<ChatToastWindowFacts>[], shared: Partial<ChatToastWindowFacts> = {}) =>
  windows.filter((w) => chatToastWindowOwns({ ...base, ...shared, ...w })).length;

test("two desktop windows toast a line once: the focused one", () => {
  expect(owners([{ isMainWindow: true }, { focused: true }], { appFocused: true })).toBe(1);
  expect(chatToastWindowOwns({ ...base, appFocused: true, isMainWindow: true })).toBe(false);
});

test("with no window focused, only the main window toasts", () => {
  expect(owners([{ isMainWindow: true }, {}, {}])).toBe(1);
  expect(chatToastWindowOwns({ ...base, isMainWindow: true })).toBe(true);
});

test("a Chat window owns chat toasts even when another window is focused", () => {
  expect(chatToastWindowOwns({ ...base, chatWindowOpen: true, focused: true, appFocused: true, isMainWindow: true })).toBe(false);
  expect(chatToastWindowOwns({ ...base, chatWindowOpen: true, isChatWindow: true })).toBe(true);
});

test("a browser tab always toasts", () => {
  expect(chatToastWindowOwns({ ...base, desktop: false })).toBe(true);
});
