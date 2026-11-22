// The agent library's two feeds now answer [] to a caller the server does not
// know (ct-74851), where they used to throw. Both collections are snapshot
// syncs, so an applied [] would drop every cached agent. A window whose
// confirmed identity lapses must keep its agents until the identity is back,
// and then show the re-authenticated answer.

import type { Root } from "react-dom/client";
import { afterAll, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import "fake-indexeddb/auto";

mock.restore();

let authenticated = true;
let answers: Record<string, unknown[] | undefined> = {};

const convexReact = await import("convex/react");
const { getFunctionName } = await import("convex/server");
mock.module("convex/react", () => ({
  ...convexReact,
  useConvexAuth: () => ({ isAuthenticated: authenticated, isLoading: false }),
  useQueries: (queries: Record<string, { query: any }>) =>
    Object.fromEntries(Object.entries(queries).map(([k, q]) => [k, answers[getFunctionName(q.query)]])),
}));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { useSyncAgentDefinitions } = await import(`${import.meta.dir}/../useSyncAgentDefinitions.ts?fresh-lost`);
const { useInboxStore } = await import("../../store/inboxStore");

afterAll(() => {
  mock.module("convex/react", () => convexReact);
  closeDomWindow(dom);
  restoreGlobals();
});

const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  _id: id, short_id: id, name, description: name, workspace: "user:me", created_at: 1, updated_at: 1, ...extra,
});
const DEF = row("k97def00000000000000000000000001", "reviewer");
const CHAIN = row("k97chn00000000000000000000000001", "ship", { steps: [{ agent: "reviewer", prompt: "p" }] });
const names = (key: "agentDefinitions" | "agentChains") =>
  Object.values((useInboxStore.getState() as any)[key] ?? {}).map((r: any) => r.name).sort();

describe("useSyncAgentDefinitions while the server identity is lost", () => {
  test("keeps cached agents through an anonymous [] and shows them after auth returns", async () => {
    const root: Root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement("div")));
    function Probe() {
      useSyncAgentDefinitions();
      return null;
    }
    const step = async (auth: boolean, defs: unknown[], chains: unknown[]) => {
      authenticated = auth;
      answers = { "agentDefinitions:list": defs, "agentDefinitions:listChains": chains };
      await act(async () => root.render(<Probe />));
    };

    await step(true, [DEF], [CHAIN]);
    expect(names("agentDefinitions")).toEqual(["reviewer"]);
    expect(names("agentChains")).toEqual(["ship"]);

    // The token refresh failed: the socket is anonymous and both feeds answer [].
    await step(false, [], []);
    expect(names("agentDefinitions")).toEqual(["reviewer"]);
    expect(names("agentChains")).toEqual(["ship"]);

    const DEF2 = row("k97def00000000000000000000000002", "writer");
    await step(true, [DEF, DEF2], [CHAIN]);
    expect(names("agentDefinitions")).toEqual(["reviewer", "writer"]);
    expect(names("agentChains")).toEqual(["ship"]);
    await act(async () => root.unmount());
  });
});
