// Wayfinding in Modern, mounted for real (jsdom, the real store, the theme
// context saying Modern): every page header opens with a back control that
// names where it goes (the tab's trail, else the page's parent), the header
// says where the page sits as crumbs, and the rail lights the section an
// object page belongs to. Classic keeps its own headers and the list-cover
// detail, untouched.
// Run: cd packages/web && bun test --isolate components/nav/__tests__/wayfinding.modern.mount.test.tsx
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installModernDom, styleValue } from "../../../test-helpers/modernDom";

const dom = installModernDom("https://app.test/tasks/ct-1");
// The lib side (pathLabel, tab titles) reads the root class the ThemeProvider sets.
dom.window.document.documentElement.classList.add("modern-style");

const React = await import("react");
const { act } = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ThemeContext } = await import("../../ThemeProvider");
const { TabParamsCtx, parseTabLocation } = await import("../../../lib/tabParams");
const { useInboxStore } = await import("../../../store/inboxStore");
const { PageHeader } = await import("../../ui/page-header");
const { DetailSplitLayout } = await import("../../DetailSplitLayout");
const { BreadcrumbBar } = await import("../../BreadcrumbBar");
const { recordTrail, _resetTrailForTests } = await import("../../../lib/navTrail");
const { placeSection } = await import("../../../lib/navPlace");
const { ModernNavView, RegistryNavSection } = await import("../../sidebar/ModernNav");

const SESSION = "jx70000000000000000000000000000s1";
const host = document.createElement("div");
document.body.append(host);
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  dom.window.sessionStorage.clear();
  _resetTrailForTests();
  useInboxStore.setState({
    sessions: { [SESSION]: { _id: SESSION, title: "Slack bot rebuild", message_count: 4, agent_type: "claude_code" } },
    projects: { pjconvex1: { _id: "pjconvex1", short_id: "pj-1", title: "Onboarding" } },
    tasks: { tk1: { _id: "tk1", short_id: "ct-1", title: "Fix login" } },
    showMySessions: false,
  } as any);
});
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
});

/** Mount `node` as the page of app tab t1, which shows `path`. */
async function mount(path: string, node: React.ReactNode, style: "modern" | "classic" = "modern") {
  useInboxStore.setState({ tabs: [{ id: "t1", path, title: "", createdAt: 0 }], activeTabId: "t1" } as any);
  const ctx = { tabId: "t1", ...parseTabLocation(path), params: {}, isActive: true, isVisible: true };
  root = createRoot(host);
  await act(() => root!.render(
    <ThemeContext.Provider value={styleValue(style)}>
      <MemoryRouter initialEntries={[path.split("?")[0]]}>
        <TabParamsCtx.Provider value={ctx}>{node}</TabParamsCtx.Provider>
      </MemoryRouter>
    </ThemeContext.Provider>,
  ));
}

const back = () => host.querySelector<HTMLButtonElement>("[data-cc-nav-back]");
const header = (title: string) => <PageHeader legacy={<div data-legacy-head>{title}</div>} title={title} />;

describe("the back control names where it goes", () => {
  test("from a list: ← Tasks, and a press takes the tab back to the list", async () => {
    recordTrail("t1", "/tasks", "push");
    recordTrail("t1", "/tasks/ct-1", "push");
    await mount("/tasks/ct-1", header("Fix login"));
    expect(back()?.textContent).toBe("Tasks");
    expect(back()?.getAttribute("aria-label")).toBe("Back to Tasks");
    expect(back()?.getAttribute("data-cc-nav-back")).toBe("trail");
    await act(async () => back()!.click());
    expect(useInboxStore.getState().tabs[0].path).toBe("/tasks");
  });

  test("from a project: ← the project, by its name", async () => {
    recordTrail("t1", "/projects/pj-1", "push");
    recordTrail("t1", "/projects/pj-1/tk1", "push");
    await mount("/projects/pj-1/tk1", header("Fix login"));
    expect(back()?.textContent).toBe("Onboarding");
    expect(back()?.getAttribute("data-cc-nav-back-to")).toBe("/projects/pj-1");
  });

  test("from a conversation: ← the session, by its title", async () => {
    recordTrail("t1", `/inbox?s=${SESSION}`, "push");
    recordTrail("t1", "/tasks/ct-1", "push");
    await mount("/tasks/ct-1", header("Fix login"));
    expect(back()?.textContent).toBe("Slack bot rebuild");
    expect(back()?.getAttribute("data-cc-nav-back-to")).toBe(`/inbox?s=${SESSION}`);
  });

  test("from a cold link: up to the object's parent", async () => {
    await mount("/tasks/ct-9", header("Fix login"));
    expect(back()?.textContent).toBe("Tasks");
    expect(back()?.getAttribute("data-cc-nav-back")).toBe("parent");
    await act(async () => back()!.click());
    expect(useInboxStore.getState().tabs[0].path).toBe("/tasks");
  });

  test("a session opened cold goes up to the inbox; a section page opened cold has no way back to name", async () => {
    await mount(`/inbox?s=${SESSION}`, header("Slack bot rebuild"));
    expect(back()?.textContent).toBe("Inbox");
    await act(() => root!.unmount());
    root = null;
    await mount("/tasks", header("Tasks"));
    expect(back()).toBeNull();
  });
});

describe("where am I", () => {
  test("a nested object reads Section › Parent, each a link, then its own name", async () => {
    await mount("/projects/pj-1/tk1", header("Fix login"));
    const crumbs = [...host.querySelectorAll("[data-cc-place-crumbs] a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(crumbs).toEqual([["Projects", "/projects"], ["Onboarding", "/projects/pj-1"]]);
    expect(host.querySelector("h1")?.textContent).toBe("Fix login");
  });

  test("a page behind More reads More ›, which opens the rail's More level", async () => {
    await mount("/memory", header("Memory"));
    let opened = 0;
    const onMore = () => { opened++; };
    window.addEventListener("codecast:rail-more", onMore);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-cc-crumb='more']")!.click());
    window.removeEventListener("codecast:rail-more", onMore);
    expect(opened).toBe(1);
  });

  test("the separate breadcrumb strip is gone in Modern, and still there in Classic", async () => {
    await mount("/tasks/tk1", <BreadcrumbBar />);
    expect(host.textContent).toBe("");
    await act(() => root!.unmount());
    root = null;
    await mount("/tasks/tk1", <BreadcrumbBar />, "classic");
    expect(host.textContent).toContain("Tasks");
    expect(host.textContent).toContain("Fix login");
  });
});

describe("the rail lights the section an object page belongs to", () => {
  const ALL = { chat: true, calls: true, changes: true, org: true, line: true, team: true, staff: true } as const;
  const shut = { items: [], expanded: false, onToggle: () => {} };
  const lit = (path: string) => {
    const activeId = placeSection(path);
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ModernNavView
          isNarrow={false}
          live={{ inbox: <RegistryNavSection id="inbox" isActive={activeId === "inbox"} isNarrow={false} /> }}
          activeId={activeId}
          gates={ALL}
          tasks={shut}
          docs={shut}
        />
      </MemoryRouter>,
    );
    return [...html.matchAll(/aria-current="page"[^>]*>(?:<[^>]+>)*([^<]+)</g)].map((m) => m[1]);
  };

  test("a PR lights Code, a run Workflows, a session Inbox, a teammate Org, a trigger Triggers", () => {
    expect(lit("/pr/acme/web/42")).toEqual(["Code"]);
    expect(lit("/workflows/runs/r1")).toEqual(["Workflows"]);
    expect(lit(`/conversation/${SESSION}`)).toEqual(["Inbox"]);
    expect(lit("/team/ada")).toEqual(["Org"]);
    expect(lit("/triggers/tr-4")).toEqual(["Triggers"]);
    expect(lit("/o/obj-1")).toEqual(["More"]);
  });
});

describe("one name everywhere", () => {
  test("the tab, the history menu and the back control name a doc, a plan and a session by their own titles", async () => {
    const { tabTitle } = await import("../../../lib/tabTitle");
    const { resolveVisit } = await import("../../../lib/recentVisits");
    const { placeName } = await import("../../../lib/placeTitle");
    useInboxStore.setState({
      docs: { d1: { _id: "d1", title: "Onboarding guide" } },
      plans: { p1: { _id: "p1", short_id: "pl-1", title: "Launch plan" } },
    } as any);
    const s = useInboxStore.getState() as any;
    for (const [path, name] of [["/docs/d1", "Onboarding guide"], ["/plans/pl-1", "Launch plan"], ["/plans?plan=pl-1", "Launch plan"], [`/inbox?s=${SESSION}`, "Slack bot rebuild"], ["/tasks/ct-1", "Fix login"]] as const) {
      expect(placeName(s, path)).toBe(name);
      if (!path.includes("?")) {
        expect(tabTitle({ id: "x", path, title: "", createdAt: 0 } as any, s.sessions, s.chatChannels ?? {}, [], undefined, undefined, null, s)).toBe(name);
        expect(resolveVisit(s, { kind: "page", key: `page:${path}`, path, ts: 1 } as any)?.title).toBe(name);
      }
    }
  });
});

describe("Classic keeps its own", () => {
  test("a page header is the page's own header, with no back control or crumbs", async () => {
    recordTrail("t1", "/tasks", "push");
    recordTrail("t1", "/tasks/ct-1", "push");
    await mount("/tasks/ct-1", header("Fix login"), "classic");
    expect(host.querySelector("[data-legacy-head]")).not.toBeNull();
    expect(back()).toBeNull();
    expect(host.querySelector("[data-cc-place-crumbs]")).toBeNull();
  });

  test("a list's open item covers the list in Classic; Modern lays them side by side when wide", async () => {
    const page = <DetailSplitLayout list={<div data-list>list</div>} closeHref="/tasks"><div data-detail>detail</div></DetailSplitLayout>;
    await mount("/tasks/ct-1", page, "classic");
    expect(host.querySelector(".cc-split")).toBeNull();
    expect(host.querySelector("[data-list]")!.parentElement!.hasAttribute("inert")).toBe(true);
    await act(() => root!.unmount());
    root = null;
    await mount("/tasks/ct-1", page);
    const split = host.querySelector(".cc-split")!;
    expect(split.getAttribute("data-cc-split")).toBe("open");
    expect(split.querySelector(".cc-split__list [data-list]")).not.toBeNull();
    expect(split.querySelector(".cc-split__detail [data-detail]")).not.toBeNull();
  });

  test("Esc on an open item in Modern goes back along the trail: to the conversation it was opened from", async () => {
    recordTrail("t1", `/inbox?s=${SESSION}`, "push");
    recordTrail("t1", "/tasks/ct-1", "push");
    const page = <DetailSplitLayout list={<div>list</div>} closeHref="/tasks"><div>detail</div></DetailSplitLayout>;
    await mount("/tasks/ct-1", page);
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    // The session opens through the inbox, in the tab's own spelling.
    expect(useInboxStore.getState().tabs[0].path).toBe(`/inbox?s=${SESSION}`);
  });
});
