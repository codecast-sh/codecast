import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Command } from "cmdk";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { DictationPaletteItem } from "../dictation/DictationPaletteItem";

// The palette's dictation row: one command whose words follow the setting,
// and choosing it flips the same switch Settings › Voice does.
// Run: bun test components/__tests__/dictationPalette.mount.test.tsx

// cmdk scrolls the selected row into view; jsdom draws nothing to scroll.
w.HTMLElement.prototype.scrollIntoView = () => {};

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

test("Turn on dictation / Turn off dictation follows the setting and flips it", async () => {
  const writes: boolean[] = [];
  let closed = 0;
  useInboxStore.setState({
    currentUser: { _id: "u", dictation_enabled: false },
    setDictationEnabled: (on: boolean) => {
      writes.push(on);
      useInboxStore.setState({ currentUser: { ...useInboxStore.getState().currentUser, dictation_enabled: on } } as any);
      return Promise.resolve();
    },
  } as any);
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Command>
        <Command.List>
          <DictationPaletteItem onDone={() => closed++} />
        </Command.List>
      </Command>,
    );
  });
  const row = () => container.querySelector("[cmdk-item]") as HTMLElement;
  expect(row().textContent).toBe("Turn on dictation");
  await act(async () => { row().click(); });
  expect(writes).toEqual([true]);
  expect(closed).toBe(1);
  expect(row().textContent).toBe("Turn off dictation");
  // The plain mic in both states: the struck one means a failed start.
  expect(row().querySelector("svg")!.getAttribute("class")).toContain("lucide-mic ");
  await act(async () => { row().click(); });
  expect(writes).toEqual([true, false]);
  expect(row().textContent).toBe("Turn on dictation");
  await act(async () => { root.unmount(); });
  container.remove();
});
