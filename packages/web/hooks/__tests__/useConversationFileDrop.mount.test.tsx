import type { Root } from "react-dom/client";
import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { PANE_DRAG_TYPE } from "../../lib/stage";
import { useConversationFileDrop } from "../useConversationFileDrop";

// The conversation's image drop lived inside ConversationView, where nothing
// could mount it. As a hook it runs under a probe: the nesting counter, the
// image filter and the pane drag that must pass through are all checked here.

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

type Drop = ReturnType<typeof useConversationFileDrop>;
let latest: Drop;
function Probe() {
  latest = useConversationFileDrop();
  return null;
}

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});
async function mount() {
  root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
  await act(async () => root!.render(<Probe />));
}

function dragEvent(types: string[], files: Array<{ type: string }> = []) {
  const calls = { prevented: 0 };
  const event = {
    preventDefault: () => { calls.prevented++; },
    stopPropagation: () => {},
    dataTransfer: { types, files },
  } as unknown as React.DragEvent;
  return { event, calls };
}

test("a drag that crosses child elements stays active until the last leave", async () => {
  await mount();
  await act(async () => latest.handleDragEnter(dragEvent(["Files"]).event));
  await act(async () => latest.handleDragEnter(dragEvent(["Files"]).event));
  expect(latest.isDragging).toBe(true);
  await act(async () => latest.handleDragLeave(dragEvent(["Files"]).event));
  expect(latest.isDragging).toBe(true);
  await act(async () => latest.handleDragLeave(dragEvent(["Files"]).event));
  expect(latest.isDragging).toBe(false);
});

test("a drop hands only the images to the composer and clears the state", async () => {
  await mount();
  const received: Array<{ type: string }>[] = [];
  latest.dropFilesRef.current = (files) => { received.push(files); };
  await act(async () => latest.handleDragEnter(dragEvent(["Files"]).event));
  const image = { type: "image/png" }, text = { type: "text/plain" };
  await act(async () => latest.handleDrop(dragEvent(["Files"], [image, text]).event));
  expect(received).toEqual([[image]]);
  expect(latest.isDragging).toBe(false);
});

test("a pane drag passes through untouched so the stage can offer a split", async () => {
  await mount();
  const { event, calls } = dragEvent([PANE_DRAG_TYPE]);
  await act(async () => latest.handleDragEnter(event));
  await act(async () => latest.handleDrop(event));
  expect(calls.prevented).toBe(0);
  expect(latest.isDragging).toBe(false);
});
