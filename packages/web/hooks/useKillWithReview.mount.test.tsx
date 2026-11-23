// A set-aside card's Kill (Stashed, Snoozed, Closed) is the same reviewed Kill
// as every other surface: a session Close set aside mid-turn sits in Stashed,
// so a bare press there would cut its turn off.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../test-helpers/globals";
import { closeDomWindow } from "../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://app.test/inbox", pretendToBeVisual: true });
const w = dom.window as any;
const restoreGlobals = replaceGlobals({
  window: w, document: w.document, navigator: w.navigator, localStorage: w.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle.bind(w),
  DocumentFragment: w.DocumentFragment, KeyboardEvent: w.KeyboardEvent, Event: w.Event, CustomEvent: w.CustomEvent, NodeFilter: w.NodeFilter, requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../store/inboxStore");
const { useKillWithReview } = await import("./useKillWithReview");

const NOW = Date.now();
const aside = { _id: "c-aside", title: "Fix the sync", message_count: 12, agent_status: "working", updated_at: NOW - 1000, is_idle: false, inbox_stashed_at: NOW - 500, inbox_closed_at: NOW - 500 };
const quiet = { _id: "c-quiet", title: "Done one", message_count: 12, agent_status: "idle", updated_at: NOW - 3_600_000, is_idle: true, inbox_stashed_at: NOW - 500 };

async function press(id: string): Promise<{ killed: string[][]; text: string; confirm: () => Promise<void> }> {
  const killed: string[][] = [];
  let kill: (ids: string[]) => void = () => {};
  function Card() {
    const k = useKillWithReview((ids) => killed.push(ids));
    kill = k.kill;
    return <>{k.dialog}</>;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<Card />); });
  await act(async () => { kill([id]); });
  const text = document.body.textContent ?? "";
  const confirm = async () => {
    const button = document.querySelector("[data-switch-confirm]") as HTMLElement | null;
    await act(async () => { button?.click(); });
    await act(async () => { root.unmount(); });
    // Radix's focus scope sends its unmount event a tick after the dialog leaves.
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    host.remove();
  };
  return { killed, text, confirm };
}

describe("a set-aside card's Kill", () => {
  test("a session Close set aside mid-turn shows the review, and kills only on confirm", async () => {
    const sessions = useInboxStore.getState().sessions;
    useInboxStore.setState({ sessions: { ...sessions, [aside._id]: aside, [quiet._id]: quiet } } as any);
    try {
      const k = await press(aside._id);
      expect(k.killed).toEqual([]);
      expect(k.text).toContain("Unfinished turns");
      expect(document.querySelector("[data-switch-confirm]")?.textContent).toContain("Kill it");
      await k.confirm();
      expect(k.killed).toEqual([[aside._id]]);

      const q = await press(quiet._id);
      expect(q.killed).toEqual([[quiet._id]]);
      await q.confirm();
    } finally {
      useInboxStore.setState({ sessions } as any);
    }
  });

  test("the sidebar wires the Stashed and Snoozed X to the reviewed Kill, not the bare one", () => {
    const src = readFileSync(new URL("../components/GlobalSessionPanel.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/const handleKillStashed = useCallback\(\(id: string\) => closedKillOf\(\[id\]\), \[closedKillOf\]\);/);
    expect(src).not.toMatch(/const handleKillStashed = killWithNotice/);
  });
});
