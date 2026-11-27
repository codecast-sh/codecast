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

// Whether the socket has confirmed who is signed in.
let authed = true;
const authListeners = new Set<() => void>();
const setAuthed = (v: boolean) => { authed = v; authListeners.forEach((l) => l()); };
const realConvex = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({
  ...realConvex,
  useConvexAuth: () => ({
    isLoading: false,
    isAuthenticated: React.useSyncExternalStore((cb) => { authListeners.add(cb); return () => authListeners.delete(cb); }, () => authed),
  }),
}));

// What the person is told: a loading notice while a task link waits, and a
// notice when a task link opens without its task.
const toasts: string[] = [];
const realSonner = { ...(await import("sonner")) };
mock.module("sonner", () => ({
  ...realSonner,
  toast: Object.assign((m: string) => { toasts.push(m); }, {
    loading: (m: string, o?: { id?: string }) => { toasts.push(`loading: ${m}`); return o?.id ?? 1; },
    dismiss: () => { toasts.push("dismiss"); },
  }),
}));

const { useInboxStore } = await import("../../store/inboxStore");
const { useComposeLink, composeLinkWait } = await import("../useComposeLink");
composeLinkWait.ms = 300;

const opened: Array<{ text?: string; context?: any }> = [];
// The page's own navigate, for a second link arriving on a mounted page (a
// desktop deep link into the app that is already open).
let go: (url: string) => void = () => {};
function Probe({ active = true }: { active?: boolean }) {
  useComposeLink(active);
  const navigate = useNavigate();
  go = (url) => navigate(url);
  return null;
}

let root: Root;
let mounts = 0;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
const open = async (url: string, active = true) => {
  await act(async () => root.render(
    <MemoryRouter key={++mounts} initialEntries={[url]}>
      <Routes>
        <Route path="/inbox" element={<Probe active={active} />} />
        <Route path="/conversation/:id" element={<Probe active={active} />} />
      </Routes>
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
  toasts.length = 0;
  taskAnswer = undefined;
  authed = true;
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
  expect(toasts).toEqual([]);
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
  expect(toasts).toEqual(["loading: Opening ct-42…", "dismiss", "dismiss"]);
  expect(location.search).toBe("");
});

test("a task the server will not hand over (unknown, or another workspace's) leaves a plain composer with the draft", async () => {
  await open("/inbox?compose=Look%20at%20this&task=ct-999");
  await act(async () => setTaskAnswer(null));
  await flush();
  expect(opened).toEqual([{ text: "Look at this", context: {} }]);
  expect(toasts).toEqual(["loading: Opening ct-999…", "dismiss", "ct-999 isn't a task you can open, so this session won't be linked to it", "dismiss"]);
});

test("an answer for a different task is never bound", async () => {
  await open("/inbox?compose=x&task=ct-1");
  await act(async () => setTaskAnswer({ _id: "k2", short_id: "ct-2", title: "Other", status: "open" }));
  await flush();
  expect(opened).toEqual([{ text: "x", context: {} }]);
});

test("a milestone's Start opens its brief as the draft and carries the priority, milestone and plan to the create", async () => {
  const { milestoneStartHref } = await import("../../lib/priorities");
  const href = milestoneStartHref(
    { short_id: "pri-57", plan: null },
    { step: { key: "s2", title: "Deploy drops the eval job", refs: [{ kind: "task", id: "ct-12" }] }, plan: { short_id: "pl-1075" } },
    () => ({ title: "Fix the eval job", status: "open" }),
  );
  await open(href);
  await act(async () => setTaskAnswer({ _id: "k12", short_id: "ct-12", title: "Fix the eval job", status: "open" }));
  await flush();
  expect(opened).toEqual([{
    text: "pri-57, milestone: Deploy drops the eval job\nOpen tasks:\n- ct-12 Fix the eval job\nPlan: pl-1075\nRun `cast priorities show pri-57` for current detail.",
    context: {
      linkedTask: { _id: "k12", short_id: "ct-12", title: "Fix the eval job", status: "open" },
      start: { priority: "pri-57", priority_step: "s2", plan: "pl-1075" },
    },
  }]);
  expect(location.search).toBe("");
  // The task link's second dismiss lands 500ms on (useComposeLink): let it, so it never lands in the next test's toasts.
  await act(async () => { await new Promise((r) => setTimeout(r, 520)); });
  expect(toasts.at(-1)).toBe("dismiss");
});

test("a Start on a team priority opens in a folder its owner maps to that team: an auto-share one, else a mapped one, never a preselected share", async () => {
  const { milestoneStartHref } = await import("../../lib/priorities");
  const { settingsDataKey } = await import("../../lib/settingsData");
  const key = settingsDataKey("directoryMappings", "me")!;
  const rules = (codecastAutoShare: boolean) => [
    { path_prefix: "/Users/me/code/union", team_id: "union", auto_share: true },
    { path_prefix: "/Users/me/code/codecast", team_id: "codecast", auto_share: codecastAutoShare },
  ];
  useInboxStore.setState({
    currentUser: { _id: "me" },
    priorities: { p58: { _id: "p58", short_id: "pri-58", workspace: "team:codecast" } },
    machineRoster: [{ device_id: "d1", local_project_roots: ["/Users/me/code"] }],
    recentProjects: [{ path: "/Users/me/code/union/app", count: 9, lastActive: 2 }, { path: "/Users/me/code/codecast/web", count: 3, lastActive: 1 }],
    settingsData: { [key]: { _id: key, value: rules(true) } },
  } as any);
  const href = milestoneStartHref({ short_id: "pri-58", plan: null }, { step: { key: "s1", title: "Ship it", refs: [] } }, () => undefined);
  await open(href);
  expect(opened.at(-1)!.context).toEqual({ projectPath: "/Users/me/code/codecast/web", gitRoot: "/Users/me/code/codecast/web", start: { priority: "pri-58", priority_step: "s1" } });
  useInboxStore.setState({ settingsData: { [key]: { _id: key, value: rules(false) } } } as any);
  await open(href);
  // Mapped without auto-share: the same folder, and nothing preselected, so the session is as private as the folder keeps it.
  expect(opened.at(-1)!.context).toEqual({ projectPath: "/Users/me/code/codecast/web", gitRoot: "/Users/me/code/codecast/web", start: { priority: "pri-58", priority_step: "s1" } });
  // A personal priority keeps the composer's usual folder.
  useInboxStore.setState({ priorities: { p58: { _id: "p58", short_id: "pri-58", workspace: "user:me" } } } as any);
  await open(href);
  expect(opened.at(-1)!.context).toEqual({ start: { priority: "pri-58", priority_step: "s1" } });
});

test("an unknown folder and an unknown agent are dropped; known ones carry", async () => {
  await open("/inbox?compose=x&project=%2Fetc&agent=gpt");
  expect(opened).toEqual([{ text: "x", context: {} }]);
  expect(toasts).toEqual(['No folder "/etc" on your machines, so this session starts in your usual one']);
  toasts.length = 0;
  await open("/inbox?compose=y&project=app&agent=codex");
  expect(toasts).toEqual([]);
  expect(opened[1]).toEqual({ text: "y", context: { projectPath: "/Users/me/code/app", gitRoot: "/Users/me/code/app", agentType: "codex" } });
});

test("a server that never answers still opens the draft after the wait", async () => {
  await open("/inbox?compose=late&task=ct-5");
  expect(opened).toEqual([]);
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
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

test("a 'not found' answered before the socket is signed in settles nothing", async () => {
  setAuthed(false);
  await open("/inbox?compose=go&task=ct-42");
  await act(async () => setTaskAnswer(null));
  await flush();
  expect(opened).toEqual([]);
  // The task is not even asked for until the socket knows the caller.
  expect(asked.filter(Boolean)).toEqual([]);
  await act(async () => setTaskAnswer({ _id: "k1", short_id: "ct-42", title: "Ship it", status: "open" }));
  await act(async () => setAuthed(true));
  await flush();
  expect(asked).toContain("ct-42");
  expect(opened).toEqual([{ text: "go ct-42 ", context: { linkedTask: { _id: "k1", short_id: "ct-42", title: "Ship it", status: "open" } } }]);
});

test("one link's timeout does not rush the next link on the same page", async () => {
  await open("/inbox?compose=first&task=ct-5");
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  expect(opened.map((o) => o.text)).toEqual(["first"]);
  await act(async () => go("/inbox?task=ct-6"));
  await flush();
  expect(opened).toHaveLength(1);
  await act(async () => setTaskAnswer({ _id: "k6", short_id: "ct-6", title: "Six", status: "open" }));
  await flush();
  expect(opened[1]?.context?.linkedTask?.short_id).toBe("ct-6");
}, 10_000);

test("a folder the task pins wins over the link's, as on the server", async () => {
  useInboxStore.setState({ projects: { p1: { _id: "p1", project_path: "/Users/me/code/app" } } } as any);
  await open("/inbox?task=ct-8&project=%2FUsers%2Fme%2Fcode%2Fapp%2Fsub");
  await act(async () => setTaskAnswer({ _id: "k8", short_id: "ct-8", title: "Eight", status: "open", project_id: "p1" }));
  await flush();
  expect(opened[0]?.context?.projectPath).toBe("/Users/me/code/app");
  await open("/inbox?task=ct-9&project=%2FUsers%2Fme%2Fcode%2Fapp%2Fsub");
  await act(async () => setTaskAnswer({ _id: "k9", short_id: "ct-9", title: "Nine", status: "open" }));
  await flush();
  expect(opened[1]?.context?.projectPath).toBe("/Users/me/code/app/sub");
});

test("a folder a teammate's task pins, on none of the viewer's machines, is never proposed: the Start folder is, and the task still binds", async () => {
  const { milestoneStartHref } = await import("../../lib/priorities");
  const { settingsDataKey } = await import("../../lib/settingsData");
  const key = settingsDataKey("directoryMappings", "me")!;
  useInboxStore.setState({
    currentUser: { _id: "me" },
    priorities: { p59: { _id: "p59", short_id: "pri-59", workspace: "team:codecast" } },
    machineRoster: [{ device_id: "d1", local_project_roots: ["/Users/me/code"] }],
    recentProjects: [{ path: "/Users/me/code/codecast/web", count: 3, lastActive: 1 }],
    settingsData: { [key]: { _id: key, value: [{ path_prefix: "/Users/me/code/codecast", team_id: "codecast", auto_share: true }] } },
  } as any);
  const href = milestoneStartHref({ short_id: "pri-59", plan: null }, { step: { key: "s1", title: "Ship it", refs: [{ kind: "task", id: "ct-31" }] } }, () => ({ title: "Their task", status: "open" }));
  await open(href);
  await act(async () => setTaskAnswer({ _id: "k31", short_id: "ct-31", title: "Their task", status: "open", project_path: "/Users/ashot/code/codecast" }));
  await flush();
  expect(opened.at(-1)!.context).toMatchObject({ projectPath: "/Users/me/code/codecast/web", linkedTask: { short_id: "ct-31" } });
  // With no Start folder either, the composer's usual folder: still never the teammate's.
  useInboxStore.setState({ settingsData: {} } as any);
  await open(href);
  await act(async () => setTaskAnswer({ _id: "k31", short_id: "ct-31", title: "Their task", status: "open", project_path: "/Users/ashot/code/codecast" }));
  await flush();
  expect(opened.at(-1)!.context.projectPath).toBeUndefined();
});

test("the same link clicked again after a timeout waits again", async () => {
  await open("/inbox?compose=a&task=ct-5");
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  expect(opened).toHaveLength(1);
  await act(async () => go("/inbox?compose=a&task=ct-5"));
  await flush();
  expect(opened).toHaveLength(1);
  await act(async () => setTaskAnswer({ _id: "k5", short_id: "ct-5", title: "Five", status: "open" }));
  await flush();
  expect(opened[1]?.context?.linkedTask?.short_id).toBe("ct-5");
}, 10_000);

test("a task row left in the store binds nothing the server will not hand over", async () => {
  // The store keeps rows from workspaces the viewer has left: the server decides.
  useInboxStore.setState({ tasks: { k3: { _id: "k3", short_id: "ct-3", title: "Three", status: "open" } } } as any);
  await open("/inbox?compose=go&task=ct-3");
  expect(opened).toEqual([]);
  await act(async () => setTaskAnswer(null));
  await flush();
  expect(opened).toEqual([{ text: "go", context: {} }]);
  useInboxStore.setState({ tasks: {} } as any);
});

test("with no machine known yet, it waits for the live roster so a machine-less account gets the assistant", async () => {
  useInboxStore.setState({ machineRoster: [], machineRosterLive: false } as any);
  await open("/inbox?compose=hi");
  expect(opened).toEqual([]);
  await act(async () => useInboxStore.setState({ machineRosterLive: true } as any));
  await flush();
  expect(opened).toEqual([{ text: "hi", context: {} }]);
});

test("no link, no composer", async () => {
  await open("/inbox?s=abc");
  expect(opened).toEqual([]);
  expect(replaced).toEqual([]);
});

test("a session link's compose is that session's draft, never a new session", async () => {
  await open("/conversation/abc?compose=About%20in-22%3A%20&task=ct-7");
  expect(opened).toEqual([]);
  expect(replaced).toEqual([]);
  expect(toasts).toEqual([]);
});
