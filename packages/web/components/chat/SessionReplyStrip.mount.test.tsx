// A chat draft that names a session shows it as a toggle: off by default, the
// line only mentions it; on, the line asks it to reply. The picker offers the
// same choice at insert time (⇧↵ or the footer button).
// Run: bun test components/chat/SessionReplyStrip.mount.test.tsx
import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "Element", "Node", "MutationObserver", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(dom.window.HTMLElement.prototype as any).scrollIntoView = () => {};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { heroConvexStub } = await import("../../app/(marketing)/heroFly/convexStub");
const { EntityFixtureContext } = await import("../../lib/entityDisplay");
const { SessionReplyStrip } = await import("./SessionReplyStrip");
const { MentionMenu } = await import("../editor/MentionMenu");
const { draftSessionsKey } = await import("../../lib/sessionReplyDraft");

const fixtures = { jx72x09: { type: "session" as const, entity: { _id: "c1", short_id: "jx72x09", title: "Manual Drive Cam Broker" } } };
const host = document.getElementById("root")!;
const root = createRoot(host);
const mount = (node: React.ReactNode) =>
  React.act(async () => root.render(
    <ConvexProvider client={heroConvexStub}>
      <MemoryRouter>
        <EntityFixtureContext.Provider value={fixtures}>{node}</EntityFixtureContext.Provider>
      </MemoryRouter>
    </ConvexProvider>,
  ));

afterAll(async () => {
  await React.act(async () => root.unmount());
  closeDomWindow(dom);
});

test("a mention shows its session off; clicking asks it to reply, with its title", async () => {
  const calls: unknown[][] = [];
  await mount(<SessionReplyStrip sessionsKey={draftSessionsKey("look at @[Manual Drive Cam Broker jx72x09]")} onToggle={(...a) => calls.push(a)} />);
  const toggle = host.querySelector<HTMLButtonElement>(".ch-reply-toggle")!;
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(toggle.textContent).toContain("Manual Drive Cam Broker");
  await React.act(async () => toggle.click());
  expect(calls).toEqual([["jx72x09", true, "Manual Drive Cam Broker"]]);
});

test("an address shows its session on", async () => {
  await mount(<SessionReplyStrip sessionsKey={draftSessionsKey("@jx72x09 what next?")} onToggle={() => {}} />);
  expect(host.querySelector(".ch-reply-toggle")!.getAttribute("aria-pressed")).toBe("true");
});

test("a draft naming no session draws nothing", async () => {
  await mount(<SessionReplyStrip sessionsKey={draftSessionsKey("plain words")} onToggle={() => {}} />);
  expect(host.querySelector(".ch-reply-strip")).toBeNull();
});

test("the picker offers ask-to-reply on a session, and only there", async () => {
  const asked: number[] = [];
  const session = { type: "session" as const, id: "c1", label: "Manual Drive Cam Broker", shortId: "jx72x09" };
  await mount(<MentionMenu items={[session]} selectedIndex={0} onHover={() => {}} onPick={() => {}} onAskReply={(i) => asked.push(i)} />);
  const button = host.querySelector<HTMLButtonElement>("[data-ask-reply]")!;
  expect(button.textContent).toContain("ask to reply");
  await React.act(async () => button.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true })));
  expect(asked).toEqual([0]);

  const task = { type: "task" as const, id: "t1", label: "A task", shortId: "ct-1" };
  await mount(<MentionMenu items={[task]} selectedIndex={0} onHover={() => {}} onPick={() => {}} onAskReply={() => {}} />);
  expect(host.querySelector("[data-ask-reply]")).toBeNull();
});
