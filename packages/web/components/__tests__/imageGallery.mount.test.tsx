import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { ImageGalleryProvider, GalleryMessageScope, useImageGallery, useGalleryMessageId, type GalleryImage } from "../ImageGallery";
import { useWatchEffect } from "../../hooks/useWatchEffect";

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
const {createRoot, type Root} = await import("react-dom/client");

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
