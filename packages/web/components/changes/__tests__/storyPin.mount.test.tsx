// Opening a story below an open drawer keeps the story where the reader
// clicked it (useStoryPin). Radix keeps the closing drawer mounted at full
// height for the commit that closes it and removes it in a re-render of its
// own subtree, so a pin measured in the page's own commit sees no change and
// the story jumps up by the closed drawer's height. The layout here is faked
// the way the browser lays the page out: a story is its row plus its drawer
// while the drawer is in the DOM and not hidden.
// Run: cd packages/web && bun test components/changes/__tests__/storyPin.mount.test.tsx
import { afterAll, expect, test } from "bun:test";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const ROW = 20;
const DRAWER = 200;
const PANE_TOP = 100;

test("opening the story below an open drawer keeps it within a pixel of where it was", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/changes", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  if (!(globalThis as any).CSS) (globalThis as any).CSS = { escape: (s: string) => s };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  afterAll(() => closeDomWindow(dom));

  let scrollTop = 300;
  const { Element: El } = dom.window as any;
  const height = (item: Element) => ROW + ([...item.querySelectorAll(".chg-drawer")].some((d) => !d.hasAttribute("hidden")) ? DRAWER : 0);
  El.prototype.getBoundingClientRect = function (this: Element) {
    const items = [...document.querySelectorAll("[data-story-key]")];
    const i = items.indexOf(this);
    const top = PANE_TOP - scrollTop + items.slice(0, Math.max(0, i)).reduce((n, el) => n + height(el), 0);
    return { top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: top, toJSON() {} };
  };

  const React = await import("react");
  const { act, useRef, useState } = React;
  const { createRoot } = await import("react-dom/client");
  const Accordion = await import("@radix-ui/react-accordion");
  const { useStoryPin } = await import("../useStoryPin");

  const handle: { open?: (key: string | undefined) => void; story?: (key: string | undefined) => void } = {};
  function Page() {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [story, setStory] = useState<string | undefined>();
    const [, setFocus] = useState(0);
    const pinStory = useStoryPin(scrollRef, story);
    // As the page does: pin, a render of its own (focus moves), and the URL's story a render later.
    handle.open = (key) => {
      pinStory(key ?? story, key);
      setFocus((n) => n + 1);
    };
    handle.story = setStory;
    return (
      <div ref={(el) => {
        (scrollRef as any).current = el;
        if (el) Object.defineProperty(el, "scrollTop", { get: () => scrollTop, set: (v: number) => void (scrollTop = v), configurable: true });
      }}>
        <Accordion.Root type="single" collapsible value={story ?? ""}>
          {["a", "b"].map((key) => (
            <Accordion.Item key={key} value={key} data-story-key={key}>
              <Accordion.Header>
                <Accordion.Trigger>{key}</Accordion.Trigger>
              </Accordion.Header>
              <Accordion.Content className="chg-drawer">evidence {key}</Accordion.Content>
            </Accordion.Item>
          ))}
        </Accordion.Root>
      </div>
    );
  }

  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<Page />));
  const topOf = (key: string) => document.querySelector(`[data-story-key="${key}"]`)!.getBoundingClientRect().top;
  const open = async (key: string) => {
    await act(async () => handle.open!(key));
    await act(async () => handle.story!(key));
  };

  await open("a");
  const shown = () => [...document.querySelectorAll(".chg-drawer:not([hidden])")].map((d) => d.textContent);
  expect(shown()).toEqual(["evidence a"]);
  const before = topOf("b");
  await open("b");
  // The first drawer has gone and the second is open under its row.
  expect(shown()).toEqual(["evidence b"]);
  expect(Math.abs(topOf("b") - before)).toBeLessThanOrEqual(1);
  expect(scrollTop).toBe(300 - DRAWER);

  // Closing the open story keeps it in place too.
  const open_b = topOf("b");
  await act(async () => handle.open!(undefined));
  await act(async () => handle.story!(undefined));
  expect(Math.abs(topOf("b") - open_b)).toBeLessThanOrEqual(1);

  await act(async () => root.unmount());
}, 60_000);
