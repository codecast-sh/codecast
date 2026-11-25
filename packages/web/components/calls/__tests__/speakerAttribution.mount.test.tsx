// A voice note's speakers on the call page: the strip under the audio, the
// names in the transcript, one picker for both, and a line's "Said by…".
// Every write is a store action; the names come from the store's row, so one
// write renames every line of a voice. Mounted in jsdom.
// Run: bun test --timeout 120000 components/calls/__tests__/speakerAttribution.mount.test.tsx
import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

let dom: any;

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let mod: typeof import("../SpeakerAttribution");
let useNamedSegments: typeof import("../speakerRoster").useNamedSegments;
let TranscriptTurnList: typeof import("../TranscriptTurns").TranscriptTurnList;
let groupTurns: typeof import("../transcriptTurnModel").groupTurns;
let useInboxStore: typeof import("../../../store/inboxStore").useInboxStore;
let withTeamRoster: typeof import("../../../test-helpers/teamRoster").withTeamRoster;

const ID = "t-voice";
const calls: Array<[string, ...unknown[]]> = [];
let turnRenders = 0;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "FocusEvent", "PointerEvent", "MutationObserver", "ResizeObserver", "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DOMRect"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (dom.window as any).Element.prototype.scrollIntoView = () => {};
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  mod = await import("../SpeakerAttribution");
  ({ useNamedSegments } = await import("../speakerRoster"));
  ({ TranscriptTurnList } = await import("../TranscriptTurns"));
  ({ groupTurns } = await import("../transcriptTurnModel"));
  ({ useInboxStore } = await import("../../../store/inboxStore"));
  ({ withTeamRoster } = await import("../../../test-helpers/teamRoster"));
}, 120_000);

afterAll(() => closeDomWindow(dom));

function seed() {
  const seg = (seq: number, k: number, text: string) => ({ seq, speaker_id: `spk:${k}`, speaker_name: `Speaker ${k + 1}`, text, t0: seq * 1000, t1: seq * 1000 + 900, at: seq });
  useInboxStore.setState({
    ...withTeamRoster([
      { _id: "u-ann", name: "Ann Lee" },
      { _id: "u-bob", name: "Bob Ray" },
    ], { clientState: useInboxStore.getState().clientState }),
    callDetails: {
      [ID]: {
        _id: ID,
        room_key: "rec:x",
        segments: [seg(1, 0, "one"), seg(2, 0, "two"), seg(3, 1, "three"), seg(4, 2, "four"), seg(5, 1, "five")],
        speakers: [
          { key: "spk:0", user_id: "u-ann", source: "person" },
          { key: "spk:1", user_id: "u-bob", source: "voice", score: 0.8 },
          { key: "spk:2", source: "voice" },
        ],
      },
    },
    assignCallSpeaker: (...a: unknown[]) => (calls.push(["assign", ...a]), Promise.resolve()),
    confirmCallSpeaker: (...a: unknown[]) => (calls.push(["confirm", ...a]), Promise.resolve()),
    moveCallLineSpeaker: (...a: unknown[]) => (calls.push(["move", ...a]), Promise.resolve()),
  } as any);
}

function Page() {
  const call = useInboxStore((s: any) => s.callDetails[ID]);
  const named = useNamedSegments(call, call.segments, true) as any[];
  return React.createElement(
    mod.SpeakerAttribution,
    { call, enabled: true },
    React.createElement(mod.SpeakerStrip, { segments: call.segments }),
    React.createElement("div", { id: "lines" }, React.createElement(React.Profiler, { id: "turns", onRender: () => void turnRenders++ }, React.createElement(TranscriptTurnList, { turns: groupTurns(named), onTurnClick: (i: number) => void calls.push(["turn", i]) }))),
  );
}

async function mount() {
  calls.length = 0;
  seed();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Page)));
  return { host, root };
}

const names = (host: Element) => [...host.querySelectorAll("#lines [data-speaker] button[aria-label$='change who this is']")].map((b) => b.textContent);
const chip = (host: Element, i: number) => host.querySelectorAll("[role=listitem]")[i] as HTMLElement;
const press = (el: Element) => act(async () => void (el as HTMLElement).click());
const key = (el: Element, k: string) =>
  act(async () => void el.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
const type = async (el: HTMLInputElement, v: string) => {
  const set = Object.getOwnPropertyDescriptor((window as any).HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(el, v);
    el.dispatchEvent(new (window as any).Event("input", { bubbles: true }));
  });
};

test("one chip per voice in order of first speech, with names, share and a confirm on a suggestion", async () => {
  const { host, root } = await mount();
  const chips = [...host.querySelectorAll("[role=listitem]")];
  expect(chips.map((c) => c.querySelector("button")!.getAttribute("aria-label"))).toEqual([
    "Ann Lee, 40% of the talking",
    "Bob Ray, suggested, 40% of the talking",
    "Speaker 3, 20% of the talking",
  ]);
  expect(chip(host, 0).querySelector("[aria-label^=Confirm]")).toBeNull();
  await press(chip(host, 1).querySelector("[aria-label='Confirm Bob Ray']")!);
  expect(calls).toEqual([["confirm", ID, "spk:1"]]);
  await act(async () => root.unmount());
});

test("the transcript names each turn through the voice, and a store write renames every line of it", async () => {
  const { host, root } = await mount();
  expect(names(host)).toEqual(["Ann Lee", "Bob Ray", "Speaker 3", "Bob Ray"]);
  expect([...host.querySelectorAll("#lines [data-turn]")].map((t) => t.getAttribute("aria-label")?.replace(/ at .*/, ""))).toEqual([
    "Turn by Ann Lee",
    "Turn by Bob Ray",
    "Turn by Speaker 3",
    "Turn by Bob Ray",
  ]);
  await act(async () => {
    const s: any = useInboxStore.getState();
    const call = s.callDetails[ID];
    useInboxStore.setState({
      callDetails: { [ID]: { ...call, speakers: call.speakers.map((x: any) => (x.key === "spk:1" ? { key: "spk:1", name: "Dana", source: "person" } : x)) } },
    } as any);
  });
  expect(names(host)).toEqual(["Ann Lee", "Dana", "Speaker 3", "Dana"]);
  expect(host.querySelectorAll("#lines [data-turn]")[1].getAttribute("aria-label")).toStartWith("Turn by Dana");
  await act(async () => root.unmount());
});

test("hovering a chip lights that voice's lines and steps the others back", async () => {
  const { host, root } = await mount();
  turnRenders = 0;
  await act(async () => void chip(host, 1).dispatchEvent(new (window as any).MouseEvent("mouseover", { bubbles: true })));
  const rule = host.querySelector("style")?.textContent ?? "";
  expect(rule).toContain('[data-speaker]:not([data-speaker="spk:1"]){opacity:.4}');
  expect([...host.querySelectorAll("#lines [data-speaker]")].map((t) => t.getAttribute("data-speaker"))).toEqual(["spk:0", "spk:1", "spk:2", "spk:1"]);
  await act(async () => void chip(host, 1).dispatchEvent(new (window as any).MouseEvent("mouseout", { bubbles: true })));
  expect(host.querySelector("style")).toBeNull();
  // The hover is one CSS rule: no turn re-rendered for it.
  expect(turnRenders).toBe(0);
  await act(async () => root.unmount());
});

test("Esc closes the picker, is marked as taken, and focus goes back to the opener", async () => {
  const { host, root } = await mount();
  let seen: boolean | null = null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") seen = e.defaultPrevented;
  };
  window.addEventListener("keydown", onKey);
  const opener = chip(host, 0).querySelector("button")!;
  await press(opener);
  await key(document.querySelector("input[aria-label='Who said this']")!, "Escape");
  window.removeEventListener("keydown", onKey);
  expect(seen).toBe(true);
  expect(document.querySelector("input[aria-label='Who said this']")).toBeNull();
  await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  expect(document.activeElement).toBe(opener);
  // An Esc from a transcript name reaches the page (its turn selection).
  let reached = false;
  const onPage = (e: KeyboardEvent) => {
    if (e.key === "Escape") reached = !e.defaultPrevented;
  };
  window.addEventListener("keydown", onPage);
  await key(host.querySelector("#lines [data-speaker-name]")!, "Escape");
  window.removeEventListener("keydown", onPage);
  expect(reached).toBe(true);
  await act(async () => root.unmount());
});

test("a suggested voice's picker asks who it is and confirms with Enter", async () => {
  const { host, root } = await mount();
  await press(chip(host, 1).querySelector("button")!);
  expect(document.body.textContent).toContain("Who is Bob Ray?");
  const first = document.querySelector("[role=option]")!;
  expect(first.textContent).toContain("Yes, it's Bob Ray");
  await key(document.querySelector("input[aria-label='Who said this']")!, "Enter");
  expect(calls).toEqual([["confirm", ID, "spk:1"]]);
  await act(async () => root.unmount());
});

test("the picker from a chip assigns by keyboard; Someone else takes the typed name", async () => {
  const { host, root } = await mount();
  await press(chip(host, 2).querySelector("button")!);
  const input = document.querySelector("input[aria-label='Who said this']") as HTMLInputElement;
  expect(input).not.toBeNull();
  const options = () => [...document.querySelectorAll("[role=option]")].map((o) => o.textContent);
  expect(options()[0]).toContain("Ann Lee");
  expect(input.getAttribute("role")).toBe("combobox");
  expect(document.getElementById(input.getAttribute("aria-controls")!)?.getAttribute("role")).toBe("listbox");
  expect([...document.querySelectorAll("[role=listbox] > [role=group]")].map((g) => g.getAttribute("aria-label"))).toEqual(["Team", "Other"]);
  await key(input, "ArrowDown");
  await key(input, "Enter");
  expect(calls).toEqual([["assign", ID, "spk:2", { user_id: "u-bob" }]]);
  await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  expect(document.activeElement).toBe(chip(host, 2).querySelector("button"));

  await press(chip(host, 2).querySelector("button")!);
  const box = document.querySelector("input[aria-label='Who said this']") as HTMLInputElement;
  await type(box, "Rosa");
  expect(options()).toEqual(["“Rosa”Enter", "Unknown"]);
  await key(box, "Enter");
  expect(calls[1]).toEqual(["assign", ID, "spk:2", { name: "Rosa" }]);
  await act(async () => root.unmount());
});

test("a transcript name opens the picker for that voice; a line's Said by moves only that line", async () => {
  const { host, root } = await mount();
  await press(host.querySelectorAll("#lines [data-speaker] button[aria-label$='change who this is']")[2]);
  const input = document.querySelector("input[aria-label='Who said this']") as HTMLInputElement;
  await type(input, "unk");
  await key(input, "ArrowDown");
  await key(input, "Enter");
  expect(calls).toEqual([["assign", ID, "spk:2", { clear: true }]]);

  const saidBy = async (seq: number) => {
    const trigger = host.querySelector(`[data-seq="${seq}"] button[aria-label="Line menu"]`)!;
    await key(trigger, "Enter");
    const item = [...document.querySelectorAll("[role=menuitem]")].find((m) => m.textContent?.includes("Said by"))!;
    await key(item, "Enter");
    await act(() => new Promise<void>((r) => setTimeout(r, 10)));
    return document.querySelector("input[aria-label='Who said this']") as HTMLInputElement;
  };
  // Ann already has a voice here: the line joins it.
  let box = await saidBy(4);
  await type(box, "ann");
  await key(box, "Enter");
  expect(calls[1]).toEqual(["move", ID, 4, "spk:0"]);
  // Someone new: a new voice, then named.
  box = await saidBy(5);
  await type(box, "Rosa");
  await key(box, "Enter");
  expect(calls.slice(2)).toEqual([
    ["move", ID, 5, "spk:3"],
    ["assign", ID, "spk:3", { name: "Rosa" }],
  ]);
  await act(async () => root.unmount());
});
