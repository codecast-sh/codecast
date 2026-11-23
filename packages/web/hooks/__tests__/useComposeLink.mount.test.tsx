// A compose link opened on the inbox: the composer opens once with the link's
// draft, bound to its task when the viewer can see the task, and the address
// loses the link's parameters. Whatever the link names that does not resolve
// (a task the server will not hand over, an unknown folder or agent, a server
// that never answers) leaves a plain composer with the draft.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test/inbox", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let location = { pathname: "/inbox", search: "" };
const replaced: string[] = [];
mock.module("next/navigation", () => ({
  useRouter: () => {
    const navigate = useNavigate();
    return React.useMemo(() => ({
      replace: (url: string) => { replaced.push(url); navigate(url, { replace: true }); },
      push: (url: string) => navigate(url),
    }), [navigate]);
  },
  useSearchParams: () => {
    const loc = useLocation();
    location = { pathname: loc.pathname, search: loc.search };
    return new URLSearchParams(loc.search);
  },
  usePathname: () => useLocation().pathname,
}));

// The task the server hands back: undefined (not answered), null (not
// visible to this viewer), or the row. Asked-for ids are recorded.
let taskAnswer: any = undefined;
const asked: (string | undefined)[] = [];
const listeners = new Set<() => void>();
const setTaskAnswer = (v: any) => { taskAnswer = v; listeners.forEach((l) => l()); };
const realTasks = { ...(await import("../useSyncTasks")) };
mock.module("../useSyncTasks", () => ({
  ...realTasks,
  useSyncTaskDetail: (id?: string) => {
    asked.push(id);
    const v = React.useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => taskAnswer);
    return id ? v : undefined;
  },
}));

const { useInboxStore } = await import("../../store/inboxStore");
const { useComposeLink } = await import("../useComposeLink");

const opened: Array<{ text?: string; context?: any }> = [];
function Probe({ active = true }: { active?: boolean }) {
  useComposeLink(active);
  return null;
}

let root: Root;
let mounts = 0;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const open = async (url: string, active = true) => {
  await act(async () => root.render(
    <MemoryRouter key={++mounts} initialEntries={[url]}>
      <Routes><Route path="/inbox" element={<Probe active={active} />} /></Routes>
    </MemoryRouter>,
  ));
  await flush();
};

beforeEach(() => {
  root?.unmount();
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  opened.length = 0;
  replaced.length = 0;
  asked.length = 0;
  taskAnswer = undefined;
  useInboxStore.setState({
    clientStateInitialized: true,
    machineRosterLive: true,
    machineRoster: [{ device_id: "d1", local_project_roots: ["/Users/me/code/app"] }] as any,
    recentProjects: [{ path: "/Users/me/code/app", count: 3, lastActive: 1 }],
    openCompose: ((text?: string, context?: any) => { opened.push({ text, context }); }) as any,
  } as any);
});

afterAll(() => {
  root?.unmount();
  closeDomWindow(dom);
});

test("a plain draft opens the composer with exactly that text and leaves the address clean", async () => {
  await open("/inbox?compose=About%20in-22%20Infrastructure%3A%20&s=keep");
  expect(opened).toEqual([{ text: "About in-22 Infrastructure: ", context: {} }]);
  expect(replaced).toEqual(["/inbox?s=keep"]);
  expect(location.search).toBe("?s=keep");
});

test("a task the viewer can see binds the session and starts in its folder", async () => {
  await open("/inbox?task=ct-42");
  expect(opened).toEqual([]);
  expect(asked).toContain("ct-42");
  await act(async () => setTaskAnswer({ _id: "k1", short_id: "ct-42", title: "Ship it", status: "open", project_path: "/Users/me/code/app" }));
  await flush();
  expect(opened).toEqual([{
    text: "Let's do this task ct-42 ",
    context: { projectPath: "/Users/me/code/app", gitRoot: "/Users/me/code/app", linkedTask: { _id: "k1", short_id: "ct-42", title: "Ship it", status: "open" } },
  }]);
  expect(location.search).toBe("");
});

test("a task the server will not hand over (unknown, or another workspace's) leaves a plain composer with the draft", async () => {
  await open("/inbox?compose=Look%20at%20this&task=ct-999");
  await act(async () => setTaskAnswer(null));
  await flush();
  expect(opened).toEqual([{ text: "Look at this", context: {} }]);
});

test("an answer for a different task is never bound", async () => {
  await open("/inbox?compose=x&task=ct-1");
  await act(async () => setTaskAnswer({ _id: "k2", short_id: "ct-2", title: "Other", status: "open" }));
  await flush();
  expect(opened).toEqual([{ text: "x", context: {} }]);
});

test("an unknown folder and an unknown agent are dropped; known ones carry", async () => {
  await open("/inbox?compose=x&project=%2Fetc&agent=gpt");
  expect(opened).toEqual([{ text: "x", context: {} }]);
  await open("/inbox?compose=y&project=app&agent=codex");
  expect(opened[1]).toEqual({ text: "y", context: { projectPath: "/Users/me/code/app", gitRoot: "/Users/me/code/app", agentType: "codex" } });
});

test("a server that never answers still opens the draft after the wait", async () => {
  await open("/inbox?compose=late&task=ct-5");
  expect(opened).toEqual([]);
  await act(async () => { await new Promise((r) => setTimeout(r, 5100)); });
  expect(opened).toEqual([{ text: "late", context: {} }]);
}, 10_000);

test("it waits for the person's settings before opening", async () => {
  useInboxStore.setState({ clientStateInitialized: false } as any);
  await open("/inbox?compose=wait");
  expect(opened).toEqual([]);
  await act(async () => useInboxStore.setState({ clientStateInitialized: true } as any));
  await flush();
  expect(opened).toEqual([{ text: "wait", context: {} }]);
});

test("a background tab does nothing, and a link opens one composer however often it renders", async () => {
  await open("/inbox?compose=bg", false);
  expect(opened).toEqual([]);
  expect(replaced).toEqual([]);
  await open("/inbox?compose=once");
  await act(async () => useInboxStore.setState({ machineRosterLive: false } as any));
  await act(async () => useInboxStore.setState({ machineRosterLive: true } as any));
  await flush();
  expect(opened.map((o) => o.text)).toEqual(["once"]);
});

test("no link, no composer", async () => {
  await open("/inbox?s=abc");
  expect(opened).toEqual([]);
  expect(replaced).toEqual([]);
});
