// Day travel (`[`, `]`) replaces the edition's cells and keeps the rest of the
// page: the live strip and the In the works rail are the same nodes after a
// step, and a reader whose keyboard was on a story (which left with the old
// day) lands on the header's date label, never on the body. The page is mounted
// as ChangesPage arranges it, with the real header and story components and
// the page's landTravelFocus, because the page itself needs the store,
// the router and the Convex feeds.
//
// j/k moves the story cursor through an external store, so a step re-renders
// the two rows it moves between and no other.
// Run: cd packages/web && bun test components/changes/__tests__/travelFocus.mount.test.tsx
import { afterAll, expect, test } from "bun:test";
import { closeDomWindow } from "../../../test-helpers/domGlobals";
import { pageSource } from "./pageSources";

async function installDom() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/changes", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "FocusEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DocumentFragment"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  if (!(globalThis as any).CSS) (globalThis as any).CSS = { escape: (s: string) => s };
  if (!(globalThis as any).ResizeObserver) (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

test("a day step keeps the strip and rail still and lands keyboard focus on the date label", async () => {
  const dom = await installDom();
  afterAll(() => closeDomWindow(dom));

  const React = await import("react");
  const { act, useLayoutEffect, useRef, useState } = React;
  const { createRoot } = await import("react-dom/client");
  const Accordion = await import("@radix-ui/react-accordion");
  const { TooltipProvider } = await import("../../ui/tooltip");
  const { ChangesHeader } = await import("../ChangesHeader");
  const { SectionBlock } = await import("../SectionBlock");
  const { buildEdition } = await import("../editionModel");
  const { StoryCtx, createFocusStore } = await import("../storyContext");
  const { EMPTY_URL } = await import("../useChangesUrlState");
  const { landTravelFocus } = await import("../useChangesKeys");
  const { story } = await import("./fixtures");

  const DAYS = ["2026-10-01", "2026-10-02"];
  const stories = DAYS.flatMap((d) => [story(`lead-${d}`, { date: d, insertions: 900 }), story(`row-${d}`, { date: d, area: "cli", area_counts: { cli: 2 } })]);
  const focus = createFocusStore();

  let step: (d: string) => void = () => {};
  function Page() {
    const [day, setDay] = useState(DAYS[0]);
    step = setDay;
    const root = useRef<HTMLDivElement>(null);
    const m = buildEdition({ stories, date: day, edition: undefined, live: [], url: EMPTY_URL });
    // As ChangesPage's layout effect on [mode, viewKey, repo].
    const first = useRef(true);
    useLayoutEffect(() => {
      if (first.current) first.current = false;
      else landTravelFocus(root.current!);
    }, [day]);
    return (
      <TooltipProvider>
        <StoryCtx.Provider value={{ focus, waiting: m.waiting, dimmed: m.dimmed, pick: focus.set }}>
          <div ref={root} className="chg-root">
            <ChangesHeader
              repos={[]} repo={undefined} date={day} today={DAYS[1]} weekDays={DAYS} volumes={{}} stats={m.stats} summarizing={null}
              url={EMPTY_URL} setUrl={() => true} mode="day" onDay={() => {}} onToday={() => {}} onStep={() => {}} onMode={() => {}}
              filterOpen={false} onToggleFilter={() => {}} filterRef={{ current: null }} options={{ areas: [], people: [] }} personName={(id) => id}
              hasSignals={false} risks={0}
            />
            <div data-strip>strip</div>
            <Accordion.Root type="single" collapsible value="">
              <div className="chg-grid">
                <div key={`main-${day}`} className="chg-span-8">
                  {m.sections.map((sec) => <SectionBlock key={sec.area} section={sec} />)}
                </div>
                <aside className="chg-works" aria-label="In the works">rail</aside>
              </div>
            </Accordion.Root>
          </div>
        </StoryCtx.Provider>
      </TooltipProvider>
    );
  }

  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<Page />));
  const rail = document.querySelector("aside");
  const strip = document.querySelector("[data-strip]");
  const trigger = document.querySelector<HTMLElement>(`[data-story-key="row-${DAYS[0]}"] [data-story-trigger]`)!;
  await act(async () => trigger.focus());
  expect(document.activeElement).toBe(trigger);

  await act(async () => step(DAYS[1]));
  expect(trigger.isConnected).toBe(false);
  expect(document.activeElement).not.toBe(document.body);
  const label = document.querySelector<HTMLElement>("[data-changes-date]")!;
  expect(document.activeElement).toBe(label);
  expect(label.getAttribute("tabindex")).toBe("-1");
  expect(label.getAttribute("aria-live")).toBe("polite");
  // The new day's rows are on screen; the rail and strip are the nodes they were.
  expect(document.querySelector(`[data-story-key="row-${DAYS[1]}"]`)).not.toBeNull();
  expect(document.querySelector("aside")).toBe(rail);
  expect(document.querySelector("[data-strip]")).toBe(strip);

  // Focus on a control that stays (a chevron) stays there.
  const chevron = document.querySelector<HTMLElement>('[aria-label="Previous day"]')!;
  await act(async () => chevron.focus());
  await act(async () => step(DAYS[0]));
  expect(document.activeElement).toBe(chevron);

  await act(async () => root.unmount());
}, 60_000);

test("ChangesPage keys only the edition's cells and lands travel focus from its view effect", () => {
  const page = pageSource("ChangesPage.tsx");
  // The rail and the strip are never inside a keyed wrapper.
  expect(page).not.toMatch(/<div key=\{(viewDate|weekKey)\}/);
  expect(page).toMatch(/<aside className=\{`chg-works /);
  for (const cell of ["head-", "main-", "brief-"]) expect(page).toContain(`key={\`${cell}\${viewDate}\`}`);
  const start = page.indexOf("useViewMoves({ mode, key: viewKey, repo }, (first) => {");
  expect(start).toBeGreaterThan(-1);
  const effect = page.slice(start, page.indexOf("\n  });", start));
  expect(effect).toContain("if (!first) landTravelFocus(el)");
  // A slide plays once per arrival: its end marks the view slid, and the class goes.
  expect(page).toMatch(/onAnimationEnd=\{\(e\) => void \(\/\^chgFrom\/\.test\(e\.animationName\) && \(slidView\.current = viewKey\)\)\}/);
  expect(page).toContain('const slide = slidView.current === viewKey ? "" :');
  const week = pageSource("WeekView.tsx");
  expect(week).toContain("key={`head-${slide?.key");
  expect(week).toContain("key={`main-${slide?.key");
});

// The first view settles when the default repository arrives for a URL that
// named none: that is part of the first mount, so the keyboard stays where it
// was and nothing slides or rises again. A real move after it lands focus on
// the date label, and a Day/Week switch ends the first paint's rise without sliding.
test("the default repository settling the first view is not a move", async () => {
  await installDom();
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { useViewMoves } = await import("../useViewMoves");
  const { landTravelFocus } = await import("../useChangesKeys");
  const seen: { travel: string | null; moved: boolean; arrivals: boolean[] } = { travel: null, moved: false, arrivals: [] };
  function Page({ mode, day, repo }: { mode: string; day: string; repo?: string }) {
    const ref = React.useRef<HTMLDivElement>(null);
    const { travel, moved } = useViewMoves({ mode, key: day, repo }, (first) => {
      seen.arrivals.push(first);
      if (!first && ref.current) landTravelFocus(ref.current);
    });
    seen.travel = travel;
    seen.moved = moved;
    return <div ref={ref}><span data-changes-date tabIndex={-1}>{day}</span></div>;
  }
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<Page mode="day" day="2026-10-01" />));
  (document.activeElement as HTMLElement | null)?.blur();
  expect(document.activeElement).toBe(document.body);
  await act(async () => root.render(<Page mode="day" day="2026-10-01" repo="codecast-sh/codecast" />));
  expect(document.activeElement).toBe(document.body);
  expect(seen).toEqual({ travel: null, moved: false, arrivals: [true] });

  await act(async () => root.render(<Page mode="day" day="2026-10-02" repo="codecast-sh/codecast" />));
  expect(document.activeElement).toBe(document.querySelector("[data-changes-date]"));
  expect(seen).toEqual({ travel: "next", moved: true, arrivals: [true, false] });

  await act(async () => root.render(<Page mode="week" day="2026-W40" repo="codecast-sh/codecast" />));
  expect(seen.travel).toBeNull();
  expect(seen.moved).toBe(true);
  await act(async () => root.unmount());
}, 60_000);

test("j/k re-renders the two rows the cursor moves between, and no other", async () => {
  await installDom();
  const React = await import("react");
  const { act, Profiler } = React;
  const { createRoot } = await import("react-dom/client");
  const Accordion = await import("@radix-ui/react-accordion");
  const { TooltipProvider } = await import("../../ui/tooltip");
  const { StoryRow } = await import("../StoryRow");
  const { StoryCtx, createFocusStore } = await import("../storyContext");
  const { story } = await import("./fixtures");

  const rows = ["a", "b", "c", "d", "e"].map((k) => story(k));
  const focus = createFocusStore();
  const ctx = { focus, waiting: new Set<string>(), dimmed: new Set<string>(), pick: focus.set };
  const renders: string[] = [];
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(
    <TooltipProvider>
      <StoryCtx.Provider value={ctx}>
        <Accordion.Root type="single" collapsible value="">
          {rows.map((s) => (
            <Profiler key={s.story_key} id={s.story_key} onRender={(id) => void renders.push(id)}>
              <StoryRow story={s} />
            </Profiler>
          ))}
        </Accordion.Root>
      </StoryCtx.Provider>
    </TooltipProvider>,
  ));
  renders.length = 0;
  await act(async () => focus.set("b"));
  expect(renders.sort()).toEqual(["b"]);
  renders.length = 0;
  await act(async () => focus.set("c"));
  expect(renders.sort()).toEqual(["b", "c"]);
  expect(document.querySelector('[data-story-key="c"]')!.getAttribute("data-focused")).toBe("true");
  expect(document.querySelector('[data-story-key="b"]')!.getAttribute("data-focused")).toBe("false");
  await act(async () => root.unmount());
}, 60_000);

test("a release stamp's card opens on keyboard focus and closes on blur", async () => {
  await installDom();
  const React = await import("react");
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { ReleaseStamp } = await import("../ReleaseStamp");
  const { CarriedCtx, carriedMap } = await import("../storyContext");
  const { story } = await import("./fixtures");
  const ship = { surface: "cli", version: "1.1.163", sha: "rel1", at: Date.parse("2026-10-02T15:27:00Z") };
  const carried = story("carried", { headline: "The stamp lists me", release: { surface: "cli", version: "1.1.163", sha: "rel1", at: ship.at } } as any);
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<CarriedCtx.Provider value={carriedMap([carried])}><ReleaseStamp ship={ship} /></CarriedCtx.Provider>));
  const pill = document.querySelector<HTMLButtonElement>("button[aria-label^='cli 1.1.163 shipped']")!;
  expect(pill).not.toBeNull();
  const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
  await act(async () => pill.focus());
  await wait(260);
  expect(document.body.textContent).toContain("The stamp lists me");
  await act(async () => pill.blur());
  await wait(220);
  expect(document.body.textContent).not.toContain("The stamp lists me");
  await act(async () => root.unmount());
}, 60_000);
