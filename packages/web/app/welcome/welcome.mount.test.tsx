// /welcome mounted on the real store: each screen shows for the facts that
// call for it, "Not now" moves on and puts the person in the simple lane, and
// tapping the first ask starts a hosted conversation with it and lands in it.
// The promise follows what the deployment can connect, the first ask waits
// for what the grant allows, and a failed read never strands the page.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/welcome", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "HTMLInputElement", "HTMLTextAreaElement", "sessionStorage", "localStorage", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router");
const { getFunctionName } = await import("convex/server");

const convex = await import("convex/react");
mock.module("convex/react", () => ({
  ...convex,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => null,
  useAction: () => async () => ({ ok: false }),
  useConvex: () => ({ query: async () => undefined, watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined }) }),
}));
const convexAuth = await import("@convex-dev/auth/react");
mock.module("@convex-dev/auth/react", () => ({ ...convexAuth, useAuthActions: () => ({ signIn: async () => {}, signOut: async () => {} }), useAuthToken: () => null }));

let signedIn = true;
const localAuth = await import("../../lib/localAuth");
mock.module("../../lib/localAuth", () => ({ ...localAuth, useLocalAuth: () => signedIn }));
mock.module("../../components/simple/LaneSync", () => ({ LaneSync: () => null }));
let connectAvailable = true;
let connectionsError: Error | undefined;
const syncSettings = await import("../../hooks/useSyncSettings");
const realSettingsData = syncSettings.useSettingsData;
mock.module("../../hooks/useSyncSettings", () => ({
  ...syncSettings,
  useSettingsData: (name: any, team?: any) => {
    const real = realSettingsData(name, team);
    return name === "connections" && connectionsError ? { data: undefined, error: connectionsError } : real;
  },
}));
mock.module("../../hooks/useQueryNoThrow", () => ({
  useQueryNoThrow: (ref: any) => {
    const name = getFunctionName(ref);
    const data = name === "auth:signInProviders" ? { google: true } : name === "googleOAuth:connectAvailable" ? connectAvailable : undefined;
    return { data, error: undefined, retry() {} };
  },
}));

const { useInboxStore } = await import("../../store/inboxStore");
const { settingsDataKey } = await import("../../lib/settingsData");
const { ASKS } = await import("../../components/simple/lane");
const { MAIL_COMING, assistantPromise } = await import("../../components/simple/assistantPromise");
const { default: Welcome } = await import("./page");

let root: Root;
const container = () => document.getElementById("root")!;
const text = () => container().textContent ?? "";
const starts: any[] = [];
const dispatchOwner = {};

async function settle(ready: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!ready() && Date.now() < until) {
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}

function Landed() {
  return <p data-landed>{useLocation().pathname}</p>;
}

async function open(path = "/welcome") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]} key={Math.random()}>
        <Routes>
          <Route path="/welcome" element={<Welcome />} />
          <Route path="*" element={<Landed />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

/** Drops one settings feed from the store, as before it first answers. */
function unanswered(name: "connections" | "googleConnections") {
  const key = settingsDataKey(name, "u_me", undefined)!;
  const { [key]: _gone, ...rest } = useInboxStore.getState().settingsData as Record<string, unknown>;
  useInboxStore.setState({ settingsData: rest } as any);
}

function setGoogle(connected: boolean) {
  const s = useInboxStore.getState();
  const conn = settingsDataKey("connections", "u_me", undefined)!;
  const goog = settingsDataKey("googleConnections", "u_me", undefined)!;
  s.syncRecord("settingsData", conn, { _id: conn, value: { apps: connected ? [{ id: "gmail", status: "connected", detail: "maya@x.me", disconnect_id: "g1" }] : [] } } as any);
  s.syncRecord("settingsData", goog, {
    _id: goog,
    value: connected ? [{ _id: "g1", email: "maya@x.me", pending: false, assistant: true, can: { read_mail: true, modify_mail: true, send_mail: true, calendar: true } }] : [],
  } as any);
}

const button = (label: string) => [...container().querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

beforeAll(() => {
  useInboxStore.getState()._setDispatch(async (action: string, args: any[]) => {
    if (action === "createSession") {
      starts.push(args[0]);
      return "k".repeat(32);
    }
    return null;
  }, { owner: dispatchOwner });
  useInboxStore.setState({ currentUser: { _id: "u_me", name: "Maya" } } as any);
  root = createRoot(container());
});

afterAll(() => {
  useInboxStore.getState()._clearDispatch(dispatchOwner);
  act(() => root.unmount());
});

beforeEach(() => {
  signedIn = true;
  connectAvailable = true;
  connectionsError = undefined;
});

describe("/welcome", () => {
  test("signed out: sign in, Google first", async () => {
    signedIn = false;
    await open();
    await settle(() => text().includes("Continue with Google"));
    expect(text()).toContain("An assistant for the busywork.");
    const first = container().querySelector("button[data-provider]");
    expect(first?.getAttribute("data-provider")).toBe("google");
    expect(text()).toContain(assistantPromise(true));
    signedIn = true;
  });

  test("signed out where Google cannot be connected: no promise of mail or calendar", async () => {
    signedIn = false;
    connectAvailable = false;
    await open();
    await settle(() => text().includes("Continue with Google"));
    expect(text()).toContain(assistantPromise(false));
    expect(text()).not.toMatch(/your mail|calendar/i);
    signedIn = true;
    connectAvailable = true;
  });

  test("not connected: connect, and Not now moves on and joins the lane", async () => {
    setGoogle(false);
    await open();
    await settle(() => text().includes("Bring in your mail and calendar"));
    expect(text()).toContain("I ask before I send an email or change your calendar.");
    await act(async () => { button("Not now")!.click(); });
    await settle(() => text().includes("What can I take off your plate?"));
    expect(text()).toContain(ASKS.planWeek);
    expect(useInboxStore.getState().clientState?.ui?.lane).toBe("simple");
  });

  test("connected: the first ask is about the week, and tapping it starts and lands", async () => {
    setGoogle(true);
    await open();
    await settle(() => text().includes(ASKS.week));
    await act(async () => { (container().querySelector(".wl-lead") as HTMLButtonElement).click(); });
    await settle(() => !!container().querySelector("[data-landed]"));
    expect(container().querySelector("[data-landed]")?.textContent).toStartWith("/simple/c/");
    await settle(() => starts.length > 0);
    expect(starts[0]).toMatchObject({ agent_type: "codecast", first_message: ASKS.week });
  });

  test("connected: the first ask waits for what the grant allows, never showing a weaker one", async () => {
    setGoogle(true);
    unanswered("googleConnections");
    await open();
    await settle(() => text().includes("Getting things ready"));
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    expect(text()).not.toContain(ASKS.replies);
    expect(text()).not.toContain(ASKS.week);
    await act(async () => { setGoogle(true); });
    await settle(() => text().includes(ASKS.week));
    expect(text()).not.toContain(ASKS.replies);
  });

  test("a skipped visit, connected since, waits for the grant before choosing the first ask", async () => {
    setGoogle(true);
    unanswered("connections");
    unanswered("googleConnections");
    await open("/welcome?step=start");
    await settle(() => text().includes("Getting things ready"));
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    expect(text()).not.toContain(ASKS.planWeek);
    expect(text()).not.toContain(ASKS.replies);
    expect(text()).not.toContain(ASKS.week);
    await act(async () => { setGoogle(true); });
    await settle(() => text().includes(ASKS.week));
    expect(text()).not.toContain(ASKS.planWeek);
    expect(text()).not.toContain(ASKS.replies);
  });

  test("a connections read that fails still lets the person on: the connect screen and its Not now", async () => {
    unanswered("connections");
    connectionsError = new Error("listConnections failed");
    await open();
    await settle(() => text().includes("Bring in your mail and calendar"));
    expect(button("Not now")).toBeTruthy();
    connectionsError = undefined;
  });

  test("where Google cannot be connected: straight to the asks, saying mail and calendar are coming", async () => {
    setGoogle(false);
    connectAvailable = false;
    await open();
    await settle(() => text().includes("What can I take off your plate?"));
    expect(text()).toContain(MAIL_COMING);
    expect(text()).not.toContain("Bring in your mail and calendar");
    connectAvailable = true;
  });
});
