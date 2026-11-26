// ct-101506: on a call's page, a teammate in the call shows the session they
// have open right now, so the person on the call reaches it in one click
// instead of searching for it with Jump to. The data is the roster's
// viewing_conversation_id (already filtered server side to sessions the viewer
// may open); the viewer's own session and an offline teammate's never show.
//
// The header row the call page draws beside its people is CallSessionChips;
// it is given the call's participants alongside the sessions the call reached.
import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const realNav = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({ ...realNav, useRouter: () => ({ push() {}, replace() {} }) }));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.codecast.sh" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../store/inboxStore");
const { CallSessionChips } = await import("../CallSessionChips");

const roots: { unmount(): void }[] = [];

afterAll(() => {
  // Unmount first: a mounted chip row stays subscribed to the store and would
  // re-render under the next file's mocks.
  act(() => roots.forEach((r) => r.unmount()));
  closeDomWindow(dom);
  restoreGlobals();
  mock.module("next/navigation", () => realNav);
});

const ChipsWithPeople = CallSessionChips as unknown as (p: any) => React.ReactElement | null;

function seed() {
  const member = (id: string, name: string, extra: any = {}) => ({ _id: id, name, role: "member", roster_team: "t1", ...extra });
  useInboxStore.setState({
    currentUser: { _id: "uMe", name: "Me" },
    clientState: { ...(useInboxStore.getState() as any).clientState, ui: { ...((useInboxStore.getState() as any).clientState?.ui ?? {}), active_team_id: "t1" } },
    teamMembers: [
      member("uMe", "Me", { presence_state: "active", viewing_conversation_id: "cMine" }),
      member("uSam", "Samvit", { presence_state: "active", viewing_conversation_id: "cSam", viewing_since: Date.now() - 60_000 }),
      member("uCy", "Cy", { presence_state: "offline", viewing_conversation_id: "cCy" }),
    ],
    sessions: {
      cMine: { _id: "cMine", title: "My own work" },
      cSam: { _id: "cSam", title: "Company wiki planning" },
      cCy: { _id: "cCy", title: "Cy stale session" },
    },
  } as any);
}

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(() =>
    root.render(
      <ChipsWithPeople
        callId="call1"
        sessions={[]}
        participants={[
          { id: "uMe", name: "Me" },
          { id: "uSam", name: "Samvit" },
          { id: "uCy", name: "Cy" },
        ]}
      />,
    ),
  );
  return container;
}

test("a teammate on the call shows the session they are working in, one click away", async () => {
  seed();
  const c = await render();
  const target = [...c.querySelectorAll("button, a")].find((el) => (el.textContent ?? "").includes("Company wiki planning") || (el.getAttribute("title") ?? "").includes("Company wiki planning"));
  expect(target, "no control on the call opens Samvit's current session").toBeTruthy();
});

test("the viewer's own session and an offline teammate's stale one never show", async () => {
  seed();
  const c = await render();
  const text = c.innerHTML;
  expect(text).not.toContain("My own work");
  expect(text).not.toContain("Cy stale session");
});
