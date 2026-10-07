// Mount one served app version in happy-dom and use it, the way a first
// visitor would: load index.html's modules, wait for the first paint, then
// click every button, type into every field, submit every form, drag across
// every canvas and press the arrow keys. Reports whether it rendered, every
// error it threw, and what it wrote through the SDK (scripts/lib/mockSdk.ts).
//
//   bun scripts/lib/mount.ts <job.json>    job: { dir, entries[], pick? }
//
// One process per mount, so apps never share a DOM or a store. The job's dir
// holds the version's served files with imports already rewritten
// (scripts/lib/served.ts).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

type Job = { dir: string; html: string; entries: string[]; pick?: { tag?: string; text?: string } };
const job: Job = await Bun.file(process.argv[2]).json();

GlobalRegistrator.register({ url: "https://app.clayground.test/", width: 1280, height: 800 });

const errors: string[] = [];
const note = (where: string, e: unknown) => {
  const text = e instanceof Error ? `${e.message}` : String(e);
  if (errors.length < 20) errors.push(`${where}: ${text.slice(0, 300)}`);
};
window.addEventListener("error", (e) => note("error", (e as ErrorEvent).error ?? (e as ErrorEvent).message));
window.addEventListener("unhandledrejection", (e) => note("rejection", (e as PromiseRejectionEvent).reason));
process.on("unhandledRejection", (e) => note("rejection", e));
const consoleError = console.error;
console.error = (...args: unknown[]) => note("console.error", args.map(String).join(" "));
(globalThis as { reportError?: (e: unknown) => void }).reportError = (e) => note("uncaught", e);

// No 2D or audio backend here: any call succeeds and draws nothing.
const anything: object = new Proxy(function () {}, {
  get: (_t, key) => (key === "measureText" ? () => ({ width: 10 }) : key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : anything),
  apply: () => anything,
  construct: () => anything,
  set: () => true,
});
(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => anything;
(HTMLCanvasElement.prototype as unknown as { toDataURL: () => string }).toDataURL = () => "data:image/png;base64,";
// No layout either: give every element a phone-sized box so pointer math is finite.
Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 390, bottom: 640, width: 390, height: 640, toJSON() {} }) as DOMRect;
for (const name of ["AudioContext", "webkitAudioContext", "OffscreenCanvas"]) (globalThis as Record<string, unknown>)[name] = anything;
(globalThis as Record<string, unknown>).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { tally } = await import("./mockSdk");
const writes = () => tally.insert + tally.update + tally.remove + tally.setShared;

const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(job.html)?.[1] ?? '<div id="root"></div>';
document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, "");
for (const entry of job.entries) {
  try {
    await import(`${job.dir}/${entry}`);
  } catch (e) {
    note(`loading ${entry}`, e);
  }
}
await sleep(400);

const painted = () => document.body.innerText.trim().length + document.querySelectorAll("canvas, svg, img").length;
const firstPaint = { text: document.body.innerText.trim().slice(0, 400), elements: document.body.querySelectorAll("*").length, painted: painted() > 0 };

let picked: unknown = null;
if (job.pick) {
  const { describeElement } = await import("../../runtime/picker");
  const want = job.pick;
  // What a person reads on an element: its text, or its label when it has none (a swatch, an icon button).
  const reads = (el: Element) => [el.textContent, el.getAttribute("aria-label"), el.getAttribute("title")].join(" ").toLowerCase();
  const matches = [...document.body.querySelectorAll(want.tag ?? "*")].filter((el) => !want.text || reads(el).includes(want.text.toLowerCase()));
  // The innermost match, the way a person clicks the thing itself rather than its container.
  const match = matches.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0];
  picked = match ? describeElement(match) : null;
}

// ---- Use it -------------------------------------------------------------------

const steps: { what: string; writes: number }[] = [];
async function step(what: string, act: () => void | Promise<void>) {
  const before = writes();
  try {
    await act();
  } catch (e) {
    note(what, e);
  }
  await sleep(60);
  steps.push({ what, writes: writes() - before });
}

for (const input of [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), textarea")].slice(0, 6)) {
  await step(`type into ${input.tagName.toLowerCase()}`, () => {
    // The prototype's setter, past React's own, so React sees a real edit.
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, "Hello from the eval 🎉");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
for (const form of [...document.querySelectorAll("form")].slice(0, 4)) {
  await step("submit form", () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function dragSurfaces() {
  for (const surface of [...document.querySelectorAll("canvas, svg, [class*=board], [class*=wall], [class*=grid], [class*=canvas]")].slice(0, 3)) {
    // A frame between events, as a real drag has, so React renders in between.
    await step(`drag across <${surface.tagName.toLowerCase()}>`, async () => {
      const at = async (type: string, x: number, y: number) => {
        surface.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", buttons: 1, isPrimary: true }));
        await sleep(16);
      };
      await at("pointerdown", 20, 20);
      for (let i = 1; i <= 20; i++) await at("pointermove", 20 + i * 10, 20 + i * 5);
      await at("pointerup", 220, 120);
      surface.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
    });
  }
}
await dragSurfaces();
for (const button of [...document.querySelectorAll("button")].slice(0, 16)) {
  if (!button.isConnected || (button.form && button.type === "submit")) continue;
  await step(`click "${(button.textContent ?? "").trim().slice(0, 30)}"`, () => button.click());
}
await dragSurfaces();
await step("press keys", () => {
  for (const key of ["ArrowRight", "ArrowUp", " ", "ArrowLeft"]) {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, code: key === " " ? "Space" : key, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent("keyup", { key, code: key === " " ? "Space" : key, bubbles: true }));
  }
});
await sleep(500);

const report = {
  ok: errors.length === 0 && firstPaint.painted,
  firstPaint,
  afterUse: { text: document.body.innerText.trim().slice(0, 400), painted: painted() > 0 },
  errors,
  sdk: { ...tally, refused: [...new Set(tally.refused)] },
  steps,
  picked,
};
console.error = consoleError;
process.stdout.write(`\n@@REPORT${JSON.stringify(report)}\n`);
process.exit(0);
