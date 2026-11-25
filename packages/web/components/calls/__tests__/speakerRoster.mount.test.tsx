// A voice note's names, everywhere a line is printed: useNamedSegments
// resolves each diarized line through callSpeakerRoster (the server's
// speaker_names win), so the passage preview, the turn names and the excerpt
// sent to an agent say who spoke, not "Speaker 1". A recording of another
// team offers none of this team's people in the picker. Mounted in jsdom.
// Run: bun test --timeout 120000 components/calls/__tests__/speakerRoster.mount.test.tsx
import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

let dom: any;
let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let roster: typeof import("../speakerRoster");
let useInboxStore: typeof import("../../../store/inboxStore").useInboxStore;
let withTeamRoster: typeof import("../../../test-helpers/teamRoster").withTeamRoster;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  roster = await import("../speakerRoster");
  ({ useInboxStore } = await import("../../../store/inboxStore"));
  ({ withTeamRoster } = await import("../../../test-helpers/teamRoster"));
}, 120_000);

afterAll(() => closeDomWindow(dom));

const seg = (seq: number, k: number, text: string) => ({ seq, speaker_id: `spk:${k}`, speaker_name: `Speaker ${k + 1}`, text, t0: seq * 1000, t1: seq * 1000 + 900, at: seq });
const segments = [seg(1, 0, "one"), seg(2, 0, "two"), seg(3, 1, "three"), seg(4, 2, "four")];
const speakers = [
  { key: "spk:0", user_id: "u-ann", source: "person" as const },
  { key: "spk:1", user_id: "u-zed", source: "voice" as const, score: 0.8 },
  { key: "spk:2", name: "Rosa", source: "person" as const },
];

async function run<T>(hook: () => T): Promise<T> {
  let out!: T;
  function Probe() {
    out = hook();
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(React.createElement(Probe)));
  await act(async () => root.unmount());
  return out;
}

test("lines are named by voice, server names win, and every printed form follows", async () => {
  useInboxStore.setState(withTeamRoster([{ _id: "u-ann", name: "Ann (local)" }, { _id: "u-bob", name: "Bob" }], { team: "t1", clientState: useInboxStore.getState().clientState }) as any);
  // u-zed is not in this window's roster: only the server knows the name.
  const call = { team_id: "t1", speakers, speaker_names: { "u-ann": "Ann Lee", "u-zed": "Zed Q" } };
  const named = (await run(() => roster.useNamedSegments(call, segments, true)))!;
  expect(named.map((s) => s.speaker_name)).toEqual(["Ann Lee", "Ann Lee", "Zed Q", "Rosa"]);

  const { buildPassages } = await import("../roomThreadModel");
  const [p] = buildPassages(named as any, [], { recording: false });
  expect(p.preview).toContain("Ann:");
  expect(p.preview).not.toContain("Speaker");

  const { excerptBody } = await import("../useCallFeed");
  const body = excerptBody({ segments: named as any, transcriptId: "t", title: "Voice note", startedAt: 0, live: false, partial: false } as any);
  expect(body).toContain("**Ann Lee**: one two");
  expect(body).toContain("**Zed Q**: three");
  expect(body).not.toContain("Speaker 1");

  const off = await run(() => roster.useNamedSegments(call, segments, false));
  expect(off).toBe(segments);
});

test("the picker offers teammates only for a recording of the active team", async () => {
  useInboxStore.setState(withTeamRoster([{ _id: "u-ann", name: "Ann" }, { _id: "u-bob", name: "Bob" }], { team: "t1", clientState: useInboxStore.getState().clientState }) as any);
  const same = await run(() => roster.useSpeakerPeople({ team_id: "t1", speaker_names: {} }));
  expect(same.people.map((p) => p._id)).toEqual(["u-ann", "u-bob"]);
  const other = await run(() => roster.useSpeakerPeople({ team_id: "t2", speaker_names: { "u-x": "Xi" } }));
  expect(other.people).toEqual([]);
  expect(other.roster).toEqual({ "u-x": "Xi" });
});
