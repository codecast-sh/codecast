import type { Root } from "react-dom/client";
import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { ImageGalleryProvider, GalleryMessageScope, useImageGallery, useGalleryMessageId, type GalleryImage } from "../ImageGallery";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore } from "../../store/inboxStore";

import { closeDomWindow } from "../../test-helpers/domGlobals";
// The lightbox provider outlives a conversation switch: the inbox keeps one
// ConversationView and swaps its data under it. Its mount registry used to
// keep every image ever registered, so an inline click in session B browsed
// session A's screenshots too. These pin the registry to the conversation and
// cover the two actions on the open image.

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// react-dom/client decides at load whether a DOM exists, so it is loaded
// here — after the globals above — not as a static import.
const { createRoot } = await import("react-dom/client");

// jsdom has no layout: the provider scrolls the active thumb into view.
(dom.window.HTMLElement.prototype as any).scrollIntoView = () => {};
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

// Registers like ImageBlock does: once mounted, under the row's message scope.
function Registered({ src, href }: { src: string; href?: string }) {
  const gallery = useImageGallery();
  const messageId = useGalleryMessageId();
  useWatchEffect(() => { gallery?.register({ src, href, messageId }); }, [gallery, src, href, messageId]);
  return <button data-src={src} onClick={() => gallery?.open(src)} />;
}

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
});

async function mount(el: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(() => root!.render(el));
}

const lightbox = () => document.body.querySelector('div[class*="fixed inset-0"]') as HTMLElement | null;
const counter = () => lightbox()?.textContent?.match(/\d+ \/ \d+/)?.[0];
const thumbSrcs = () => Array.from(lightbox()?.querySelectorAll("img.h-9") ?? []).map((i) => (i as HTMLImageElement).getAttribute("src"));
const clickSrc = async (src: string) => act(() => { (container!.querySelector(`[data-src="${src}"]`) as HTMLElement).click(); });

test("switching conversations drops the previous conversation's registered images", async () => {
  const view = (conversationId: string, images: GalleryImage[]) => (
    <ImageGalleryProvider conversationId={conversationId}>
      {images.map((i) => <Registered key={i.src} {...i} />)}
    </ImageGalleryProvider>
  );
  await mount(view("A", [{ src: "a1" }, { src: "a2" }]));
  await clickSrc("a2");
  expect(counter()).toBe("2 / 2");
  expect(thumbSrcs()).toEqual(["a1", "a2"]);

  // Switch: new data under the same provider, the way the inbox does it. The
  // open lightbox closes and the registry starts over.
  await act(() => root!.render(view("B", [{ src: "b1" }, { src: "b2" }])));
  expect(lightbox()).toBeNull();
  await clickSrc("b1");
  expect(counter()).toBe("1 / 2");
  expect(thumbSrcs()).toEqual(["b1", "b2"]);
});

test("the open image offers its link and the way back to its message", async () => {
  const jumps: string[] = [];
  await mount(
    <ImageGalleryProvider conversationId="conv1" onJumpToMessage={(id) => jumps.push(id)}>
      <GalleryMessageScope messageId="msg9">
        <Registered src="blob:local" href="https://files.example/s1.png" />
      </GalleryMessageScope>
      <Registered src="data:image/png;base64,AAAA" />
    </ImageGalleryProvider>,
  );
  await clickSrc("blob:local");
  const copy = lightbox()!.querySelector('[aria-label="Copy link to image"]');
  const jump = lightbox()!.querySelector('button[aria-label="Locate in the conversation"]') as HTMLButtonElement;
  expect(copy).not.toBeNull();
  expect(jump).not.toBeNull();
  await act(() => { jump.click(); });
  expect(jumps).toEqual(["msg9"]);
  expect(lightbox()).toBeNull();

  // An inline base64 image outside any message scope has nowhere to link or jump.
  await clickSrc("data:image/png;base64,AAAA");
  expect(lightbox()!.querySelector('[aria-label="Copy link to image"]')).toBeNull();
  expect(lightbox()!.querySelector('button[aria-label="Locate in the conversation"]')).toBeNull();
});

test("a trackpad pinch zooms the open image, 0 resets, paging resets", async () => {
  await mount(
    <ImageGalleryProvider conversationId="A">
      <Registered src="z1" />
      <Registered src="z2" />
    </ImageGalleryProvider>,
  );
  await clickSrc("z1");
  // The zoom transform sits on the box around the picture, which also holds its pins.
  const zoomBox = () => lightbox()!.querySelector('img[alt="Gallery image"]')!.parentElement as HTMLElement;
  const scaleOf = () => Number(zoomBox().style.transform.match(/scale\(([\d.]+)\)/)?.[1]);
  expect(scaleOf()).toBe(1);

  // Chromium reports a pinch as a ctrl+wheel with negative deltaY to zoom in.
  const pinch = (deltaY: number) => act(() => {
    lightbox()!.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY, ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await pinch(-40);
  expect(scaleOf()).toBeGreaterThan(1.4);
  expect(lightbox()!.textContent).toContain("reset");

  // Zoom never goes below 100%.
  await pinch(50); await pinch(50); await pinch(50);
  expect(scaleOf()).toBe(1);

  await pinch(-40);
  await act(() => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "0", bubbles: true })); });
  expect(scaleOf()).toBe(1);

  await pinch(-40);
  await act(() => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(counter()).toBe("2 / 2");
  expect(scaleOf()).toBe(1);
});

test("clicking a point of the picture pins a note there, and a click before writing moves it", async () => {
  useInboxStore.setState({ reviewComments: {}, reviewEditingId: null } as any);
  await mount(
    <ImageGalleryProvider conversationId="P" quotable>
      <Registered src="p1" href="https://files.example/p1.png" />
    </ImageGalleryProvider>,
  );
  await clickSrc("p1");
  const img = lightbox()!.querySelector('img[alt="Gallery image"]') as HTMLImageElement;
  img.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 200, right: 500, bottom: 250, x: 100, y: 50, toJSON() {} });
  const clickAt = (clientX: number, clientY: number) => act(() => {
    img.dispatchEvent(new dom.window.MouseEvent("click", { clientX, clientY, bubbles: true }));
  });
  const pins = () => useInboxStore.getState().reviewComments.P ?? [];

  await clickAt(200, 100);
  expect(pins().map((c) => c.image?.point)).toEqual([{ x: 0.25, y: 0.25 }]);
  expect(lightbox()!.querySelector('button[aria-label="Note 1"]')).not.toBeNull();
  expect(lightbox()!.querySelector("textarea")).not.toBeNull();

  // Still no note: the click was a miss, so the pin moves rather than doubles.
  await clickAt(400, 200);
  expect(pins().map((c) => c.image?.point)).toEqual([{ x: 0.75, y: 0.75 }]);

  // Once it has a note, the next click is a second pin.
  await act(() => { useInboxStore.getState().commitReviewComment("P", pins()[0].id, "this one"); });
  await clickAt(300, 150);
  expect(pins().map((c) => c.image?.point)).toEqual([{ x: 0.75, y: 0.75 }, { x: 0.5, y: 0.5 }]);
  expect(lightbox()!.textContent).toContain("2 notes on your next message");
});
