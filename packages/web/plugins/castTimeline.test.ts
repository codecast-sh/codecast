// The page timeline contract (window.__castTimeline) as the two players that
// provide it implement it, run in jsdom: the motion player over a HyperFrames
// composition (lib/castMotion.ts, with a stub runtime player and a stub
// window.cast data runtime) and <cast-player> (lib/castPlayer.ts).
// Run: bun test plugins/castTimeline.test.ts
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { CAST_MOTION_JS } from "../../convex/convex/lib/castMotion";
import { castPlayerScript } from "../../convex/convex/lib/castPlayer";

const COMPOSITION = `<!doctype html><html><head><base href="https://pages.test/cli/a/slug/"><title>Hill docks</title></head><body>
<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="10">
  <section class="clip" data-start="0" data-duration="4"><h1>Why are the hill docks empty?</h1></section>
  <section class="clip" data-start="4" data-duration="6"><b id="n" data-cast-data="docks" data-cast-col="empty" data-cast-row="-1" data-cast-format="int">12</b><i id="first" data-cast-data="docks" data-cast-col="1">x</i><u id="sum" data-cast-data="docks" data-cast-col="empty" data-cast-agg="sum" data-cast-format="int">0</u></section>
</div>
<input id="field"></body></html>`;

/** A HyperFrames runtime player on a fake clock the test moves by hand. */
function stubPlayer() {
  const p = {
    t: 0,
    on: false,
    seeks: [] as number[],
    play() { p.on = true; },
    pause() { p.on = false; },
    seek(t: number) { p.t = t; p.seeks.push(t); },
    getTime: () => p.t,
    getDuration: () => 10,
    isPlaying: () => p.on,
  };
  return p;
}

type Win = JSDOM["window"] & Record<string, any>;

async function motionPage(opts: { data?: boolean; manifest?: boolean; html?: string; timeline?: unknown } = {}) {
  const dom = new JSDOM(opts.html ?? COMPOSITION, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://pages.test/cli/a/slug/" });
  const win = dom.window as Win;
  const player = stubPlayer();
  win.__player = player;
  win.__playerReady = true;
  if (opts.timeline) win.__timelines = { main: opts.timeline };
  // jsdom has no Web Animations: one animation inside the composition, one on the page's own chrome.
  const inside = { effect: { target: win.document.querySelector("#root h1") } };
  const outside = { effect: { target: win.document.getElementById("field") } };
  win.document.getAnimations = () => [inside, outside];
  const subs: Record<string, (r: unknown) => void> = {};
  if (opts.data) {
    win.cast = {
      data: async () => ({ columns: ["hour", "empty"], rows: [["7:00", 3], ["8:15", 1234.4]], refreshed_at: 1, query_text: "q", stale: false }),
      subscribe: (id: string, cb: (r: unknown) => void) => { subs[id] = cb; return () => {}; },
    };
  }
  const fetched: string[] = [];
  win.fetch = async (url: string) => {
    fetched.push(url);
    if (!opts.manifest) return { ok: false, json: async () => null };
    return { ok: true, json: async () => ({ mp4: "cast-render/motion.mp4", rendered_at: 1_700_000_000_000 }) };
  };
  let readyEvents = 0;
  win.addEventListener("cast:timeline-ready", () => readyEvents++);
  win.eval(CAST_MOTION_JS);
  await new Promise((r) => setTimeout(r, 30));
  return { win, doc: win.document, player, subs, fetched, readyEvents: () => readyEvents };
}

const frame = () => new Promise((r) => setTimeout(r, 40));

test("the motion player wraps the composition in a fitted stage and announces the timeline", async () => {
  const { win, doc, readyEvents } = await motionPage();
  const tl = win.__castTimeline;
  expect(tl.__source).toBe("motion");
  expect(readyEvents()).toBe(1);
  expect(doc.getElementById("root")!.parentElement!.id).toBe("__cm_scale");
  expect(doc.getElementById("__cm_scale")!.style.width).toBe("1920px");
  expect(doc.getElementById("__cm_scale")!.style.transform).toMatch(/^scale\(/);
  expect(tl.duration()).toBe(10);
  // One beat tick per top level clip after the first.
  expect(doc.querySelectorAll(".__cm_tick").length).toBe(1);
});

test("the page opens on a poster still and play starts from the top", async () => {
  // No timeline to read: the middle of the first beat (0-4s).
  const plain = await motionPage();
  expect(plain.win.__castTimeline.time()).toBeCloseTo(2.1, 5);
  plain.win.__castTimeline.play();
  expect(plain.player.t).toBe(0);
  plain.win.__castTimeline.pause();
  // The first beat's tweens end at 1.4s: the poster is just after it settles.
  const parts = [{ startTime: () => 0.2, endTime: () => 1.4 }, { startTime: () => 5, endTime: () => 9 }];
  const settled = await motionPage({ timeline: { getChildren: () => parts } });
  expect(settled.win.__castTimeline.time()).toBeCloseTo(1.5, 5);
  expect(settled.doc.querySelector("#__cm_time b")!.textContent).toBe("0:01.5");
  // A scrub replaces the poster: play then continues from where it is.
  settled.win.__castTimeline.seek(6);
  settled.win.__castTimeline.play();
  expect(settled.player.t).toBe(6);
  settled.win.__castTimeline.pause();
  // The composition names its own poster.
  const named = await motionPage({ html: COMPOSITION.replace('data-duration="10">', 'data-duration="10" data-poster="7.25">') });
  expect(named.win.__castTimeline.time()).toBe(7.25);
});

test("the runtime only sees the composition's own animations", async () => {
  const { doc } = await motionPage();
  const seen = (doc as any).getAnimations();
  expect(seen.length).toBe(1);
  expect(seen[0].effect.target.tagName).toBe("H1");
});

test("seek clamps to the composition, play/pause drive the runtime, and the end stops instead of looping", async () => {
  const { win, player } = await motionPage();
  const tl = win.__castTimeline;
  tl.seek(4.5);
  expect(tl.time()).toBe(4.5);
  tl.seek(99);
  expect(tl.time()).toBe(10);
  tl.seek(-3);
  expect(tl.time()).toBe(0);
  tl.play();
  expect(tl.playing()).toBe(true);
  player.t = 10;
  await frame();
  expect(tl.playing()).toBe(false);
  // Play from the end replays from the top.
  tl.play();
  expect(player.t).toBe(0);
  expect(tl.playing()).toBe(true);
  // A runtime that wraps to the start on its own reads as the end, too.
  player.t = 9.5;
  await frame();
  player.t = 0.1;
  await frame();
  expect(tl.playing()).toBe(false);
  expect(player.t).toBe(10);
  tl.pause();
});

test("markers draw on the scrubber at their times and a click seeks there and reports it", async () => {
  const { win, doc } = await motionPage();
  const tl = win.__castTimeline;
  const clicked: unknown[] = [];
  win.addEventListener("cast:marker", (e: any) => clicked.push(e.detail));
  tl.setMarkers([
    { t: 2.5, n: 1, label: "hold on the empty dock a beat longer", id: "c1" },
    { t: 8, n: 2, label: "", avatar: "https://x.test/a.png" },
    { t: Number.NaN, n: 3, label: "dropped" },
  ]);
  const mk = doc.querySelectorAll<HTMLElement>(".__cm_mk");
  expect(mk.length).toBe(2);
  expect(mk[0].style.left).toBe("25%");
  expect(mk[0].textContent).toBe("1");
  expect(mk[1].querySelector("img")!.getAttribute("src")).toBe("https://x.test/a.png");
  mk[0].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  expect(tl.time()).toBe(2.5);
  expect(clicked).toEqual([{ id: "c1", t: 2.5, n: 1 }]);
  tl.setMarkers([]);
  expect(doc.querySelectorAll(".__cm_mk").length).toBe(0);
});

test("keyboard steps the timeline but leaves typing alone", async () => {
  const { win, doc } = await motionPage();
  const tl = win.__castTimeline;
  tl.seek(0);
  const key = (k: string, target: EventTarget = doc.body, shiftKey = false) =>
    target.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, shiftKey }));
  key("ArrowRight");
  expect(tl.time()).toBe(1);
  key("ArrowRight", doc.body, true);
  expect(tl.time()).toBe(6);
  key(".");
  expect(tl.time()).toBeCloseTo(6 + 1 / 30, 5);
  key("Home");
  expect(tl.time()).toBe(0);
  key(" ");
  expect(tl.playing()).toBe(true);
  key(" ");
  expect(tl.playing()).toBe(false);
  const field = doc.getElementById("field")!;
  field.focus();
  key("ArrowRight", field);
  expect(tl.time()).toBe(0);
});

test("live numbers fill bound elements from window.cast.data and follow updates", async () => {
  const { win, doc, subs } = await motionPage({ data: true });
  await frame();
  expect(doc.getElementById("n")!.textContent).toBe("1,234");
  expect(doc.getElementById("first")!.textContent).toBe("3");
  expect(doc.getElementById("sum")!.textContent).toBe("1,237");
  subs.docks({ columns: ["hour", "empty"], rows: [["8:15", 40]], refreshed_at: 2, query_text: "q", stale: true });
  expect(doc.getElementById("n")!.textContent).toBe("40");
  expect(doc.getElementById("n")!.hasAttribute("data-cast-stale")).toBe(true);
  expect(await win.castMotion.value("docks", "empty", -1)).toBe(1234.4);
  expect(await win.castMotion.value("docks", "nope")).toBe(null);
  expect(await win.castMotion.value("docks", "empty", 0, "max")).toBe(1234.4);
  expect(await win.castMotion.value("docks", null, 0, "count")).toBe(2);
});

test("without a data runtime the authored numbers stay", async () => {
  const { win, doc } = await motionPage();
  expect(doc.getElementById("n")!.textContent).toBe("12");
  expect(await win.castMotion.value("docks", "empty")).toBe(null);
});

test("a directory with a render offers the MP4 as a download", async () => {
  const { doc, fetched } = await motionPage({ manifest: true });
  await frame();
  expect(fetched).toEqual(["https://pages.test/cli/a/slug/cast-render/motion.json"]);
  const a = doc.getElementById("__cm_dl") as HTMLAnchorElement;
  expect(a.hidden).toBe(false);
  expect(a.getAttribute("href")).toBe("https://pages.test/cli/a/slug/cast-render/motion.mp4?download=Hill-docks.mp4");
  const none = await motionPage();
  await frame();
  expect((none.doc.getElementById("__cm_dl") as HTMLAnchorElement).hidden).toBe(true);
});

const VIDEO_PAGE = `<!doctype html><html><body>
<cast-player id="p" title="Film"><cast-chapter src="a.mp4" title="One" duration="20"></cast-chapter><cast-chapter src="b.mp4" title="Two" duration="30"></cast-chapter></cast-player>
</body></html>`;

async function videoPage(prelude?: (win: Win) => void) {
  const dom = new JSDOM(VIDEO_PAGE, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://pages.test/cli/a/v" });
  const win = dom.window as Win;
  // jsdom has no media engine.
  win.HTMLMediaElement.prototype.load = () => {};
  win.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  win.HTMLMediaElement.prototype.pause = () => {};
  let ready = 0;
  win.addEventListener("cast:timeline-ready", () => ready++);
  prelude?.(win);
  win.eval(castPlayerScript({ upgradeVideos: true }));
  await new Promise((r) => setTimeout(r, 30));
  return { win, ready: () => ready, player: win.document.getElementById("p") as any };
}

test("<cast-player> answers the page timeline over its whole film, with markers on its scrubber", async () => {
  const { win, ready, player } = await videoPage();
  const tl = win.__castTimeline;
  expect(tl.__source).toBe("cast-player");
  expect(ready()).toBe(1);
  expect(tl.duration()).toBe(50);
  tl.seek(25);
  expect(player.chapterIndex).toBe(1);
  tl.setMarkers([{ t: 5, n: 1, label: "tighten this cut" }, { t: 42, n: 2, label: "" }]);
  const marks = player.shadowRoot.querySelectorAll(".mk");
  expect(marks.length).toBe(2);
  expect(marks[0].textContent).toBe("1");
  expect(player.hasAttribute("data-marks")).toBe(true);
  const seen: unknown[] = [];
  win.addEventListener("cast:marker", (e: any) => seen.push(e.detail));
  marks[0].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  expect(player.chapterIndex).toBe(0);
  expect(seen).toEqual([{ id: null, t: 5, n: 1 }]);
});

test("<cast-player> leaves a motion page's timeline alone", async () => {
  const motion = { __source: "motion", time: () => 0, duration: () => 1, seek: () => {} };
  const { win } = await videoPage((w) => { w.__castTimeline = motion; });
  expect(win.__castTimeline).toBe(motion);
});
