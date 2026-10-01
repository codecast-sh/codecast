/**
 * The capability table the fake helper reports. Its own module so a test can
 * read it without starting the fake: capabilities.guard.test.ts parses the
 * Swift ProviderCapabilities and fails when the two disagree, so a capability
 * the real helper flips cannot leave the fake-backed tests green against a
 * table it no longer reports.
 */
export const FAKE_SUPPORTS = {
  apps: { list: true, bundleIds: true, pids: true },
  windows: { list: true, targetById: true, targetByIndex: true, focus: false, moveResize: false },
  observation: { screenshot: true, annotatedScreenshot: false, elementFrames: true, ocr: false },
  actions: { click: true, typeText: true, pressKey: true, hotkey: true, pasteText: true, scroll: true, drag: true, setValue: true, performAction: true },
  surfaces: { menus: false, dialogs: false, dock: false, menubar: false },
};
