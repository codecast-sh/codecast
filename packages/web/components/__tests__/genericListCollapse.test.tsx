import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { MemoryRouter } from "react-router";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { ListGroup } from "../GenericListView";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "https://codecast.sh/tasks",
});
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  localStorage: dom.window.localStorage,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperties(dom.window.HTMLElement.prototype, {
  offsetHeight: { get() { return this.hasAttribute("data-index") ? 40 : 600; } },
  offsetWidth: { get: () => 1000 },
});
dom.window.HTMLElement.prototype.scrollTo = () => {};

const { createRoot } = await import("react-dom/client");
const { GenericListView } = await import("../GenericListView");
const tasks = [{ id: "a", title: "Review task" }, { id: "b", title: "Ship task" }];
type Task = (typeof tasks)[number];
const groups: ListGroup<Task>[] = [
  { key: "alice", label: "Alice", items: [tasks[0]] },
  { key: "bob", label: "Bob", items: [tasks[1]] },
];
const host = document.createElement("div");
document.body.append(host);
let root: ReturnType<typeof createRoot>;

afterEach(async () => {
  await act(() => root.unmount());
});
afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

async function mount(listGroups: ListGroup<Task>[] | null, flatItems: Task[] = tasks) {
  root = createRoot(host);
  await act(() => root.render(
    <MemoryRouter initialEntries={["/tasks"]}>
      <GenericListView<Task>
        title="Tasks"
        tabs={[]}
        activeTab=""
        onTabChange={() => {}}
        groups={listGroups}
        flatItems={flatItems}
        renderRow={(item) => <span data-task={item.id}>{item.title}</span>}
        getItemId={(item) => item.id}
        getItemRoute={(item) => `/tasks/${item.id}`}
        getSearchText={(item) => item.title}
        emptyMessage="No tasks found"
        onCreate={() => {}}
      />
    </MemoryRouter>,
  ));
}

function button(text: string) {
  return [...host.querySelectorAll("button")].find((el) => el.textContent === text);
}

async function click(text: string) {
  const target = button(text);
  expect(target).toBeDefined();
  await act(() => target!.click());
}

test("collapsing every group keeps its header and lets each task return", async () => {
  await mount(groups);
  expect(host.querySelectorAll("[data-task]")).toHaveLength(2);
  await click("Alice(1)");
  expect(host.querySelectorAll("[data-task]")).toHaveLength(1);
  await click("Bob(1)");
  expect(host.querySelectorAll("[data-task]")).toHaveLength(0);
  expect(host.textContent).not.toContain("No tasks found");
  expect(button("Alice(1)")).toBeDefined();
  expect(button("Bob(1)")).toBeDefined();
  await click("Alice(1)");
  expect(host.querySelector('[data-task="a"]')).not.toBeNull();
  expect(host.querySelector('[data-task="b"]')).toBeNull();
  await click("Bob(1)");
  expect(host.querySelectorAll("[data-task]")).toHaveLength(2);
});

test("a collapsed parent with only nested tasks remains available to reopen", async () => {
  await mount([{ key: "team", label: "Team", items: [], depth: 0 }, ...groups.map((g) => ({ ...g, depth: 1 }))]);
  await click("Team(0)");
  expect(host.textContent).not.toContain("No tasks found");
  expect(button("Team(0)")).toBeDefined();
  expect(button("Alice(1)")).toBeUndefined();
  await click("Team(0)");
  expect(host.querySelectorAll("[data-task]")).toHaveLength(2);
});

test.each([{ listGroups: null }, { listGroups: [] }])("an empty list still offers creation (%j)", async ({ listGroups }) => {
  await mount(listGroups, []);
  expect(host.textContent).toContain("No tasks found");
  expect(button("Create one")).toBeDefined();
});

test("a search with no matches shows No results even when groups were collapsed", async () => {
  await mount(groups);
  await click("Alice(1)");
  await click("Bob(1)");
  await act(() => host.querySelector<HTMLButtonElement>('button[title="Search"]')!.click());
  const input = host.querySelector("input")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, "missing");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  expect(host.textContent).toContain("No results");
  expect(button("Create one")).toBeUndefined();
});
