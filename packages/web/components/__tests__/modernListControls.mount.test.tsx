// The list pages' toolbar in the Modern style (Tasks, Docs, Decisions all draw
// GenericListView): the status tabs, the toolbar buttons, the filter chips,
// the view actions and the hand-built menus wear the primitives' Modern looks
// (components/ui/modernLook.ts), and Classic draws exactly the classes it drew
// before them (the snapshot was taken from the components before the Modern
// classes were added; `modern:` classes are left out of it).
import { describe, expect, test } from "bun:test";
import { installModernDom, styleValue, classicClasses, wears } from "../../test-helpers/modernDom";

installModernDom("https://app.test/tasks");

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ThemeContext } = await import("../ThemeProvider");
const { GenericListView } = await import("../GenericListView");
const { modernButton, modernChip, modernTab, modernTabList, modernMenuRow, modernPopover } = await import("../ui/modernLook");

type Item = { id: string; title: string };
const items: Item[] = [{ id: "a", title: "Review task" }, { id: "b", title: "Ship task" }];
const noop = () => {};
const Icon = (p: any) => <svg {...p} />;

function List() {
  return (
    <GenericListView<Item>
      title="Tasks"
      tabs={[
        { key: "open", label: "Open", count: 4, icon: Icon },
        { key: "done", label: "Done", count: 2 },
        { key: "all", label: "All" },
      ]}
      activeTab="open"
      onTabChange={noop}
      groupBy="none"
      groupOptions={[{ value: "none", label: "None" }, { value: "status", label: "Status" }]}
      onGroupChange={noop}
      sortBy="updated"
      sortOptions={[{ value: "updated", label: "Updated" }, { value: "created", label: "Created" }]}
      onSortChange={noop}
      sortDir="desc"
      onSortDirChange={noop}
      filters={{
        hasActive: true,
        onClear: noop,
        onSaveView: noop,
        dirtyView: { name: "Mine", onUpdate: noop, onDiscard: noop, canUpdate: true },
        defs: [
          { key: "status", label: "Status", icon: <Icon />, value: "open", onChange: noop, options: [{ key: "", label: "Any" }, { key: "open", label: "Open" }, { key: "done", label: "Done" }] },
          { key: "label", label: "Label", icon: <Icon />, value: "", onChange: noop, options: [{ key: "", label: "Any" }, { key: "infra", label: "infra" }] },
        ],
      }}
      shareUrl={() => "https://codecast.sh/tasks"}
      groups={null}
      flatItems={items}
      renderRow={(item) => <span data-task={item.id}>{item.title}</span>}
      getItemId={(item) => item.id}
      getItemRoute={(item) => `/tasks/${item.id}`}
      getSearchText={(item) => item.title}
      onCreate={noop}
    />
  );
}

async function render(style: "classic" | "modern") {
  document.documentElement.classList.toggle("modern-style", style === "modern");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <ThemeContext.Provider value={styleValue(style)}>
      <MemoryRouter initialEntries={["/tasks"]}><List /></MemoryRouter>
    </ThemeContext.Provider>,
  ));
  const byTitle = (t: string) => ([...host.querySelectorAll("button")].find((el) => el.getAttribute("title") === t) ?? null) as HTMLButtonElement | null;
  // Open every hand-built menu the toolbar has: the display options, the
  // header's filter menu, the status chip's options and the folded tabs.
  for (const t of ["Display options", "Filter", "Edit Status", "Open"]) {
    const b = byTitle(t);
    if (b) await act(async () => b.click());
  }
  return { host, byTitle, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

describe("the list toolbar in Modern", () => {
  test("Classic draws the classes it drew before the Modern looks", async () => {
    const { host, unmount } = await render("classic");
    expect(classicClasses(host)).toMatchSnapshot();
    await unmount();
  });

  test("the toolbar's buttons, tabs, chips and menus wear the Modern looks", async () => {
    const { host, byTitle, unmount } = await render("modern");
    // Toolbar buttons: outline at 28px, the create button an icon button.
    expect(wears(byTitle("Display options"), modernButton({ variant: "outline", size: "sm" }))).toBe(true);
    expect(wears(byTitle("Command palette"), modernButton({ variant: "outline", size: "sm" }))).toBe(true);
    expect(wears(byTitle("Search"), modernButton({ variant: "outline", size: "icon-sm" }))).toBe(true);
    expect(wears(byTitle("Create new"), modernButton({ variant: "outline", size: "icon-sm" }))).toBe(true);
    // The filter button is a chip, on while a filter is set.
    expect(wears(byTitle("Filter"), modernChip({ active: true }))).toBe(true);
    expect(wears(byTitle("Add filter"), modernChip())).toBe(true);
    // The view actions are ghost buttons at 24px.
    for (const t of ["Copy link to this view", "Clear filters", `Go back to "Mine" as saved`]) {
      expect(wears(byTitle(t), modernButton({ variant: "ghost", size: "xs" }))).toBe(true);
    }
    // The status tabs: the tray, the open tab raised.
    const tabs = host.querySelector("[data-list-tabs]");
    expect(wears(tabs, modernTabList)).toBe(true);
    const tabButtons = [...tabs!.querySelectorAll("button")];
    expect(wears(tabButtons[0], modernTab({ active: true }))).toBe(true);
    expect(wears(tabButtons[1], modernTab({ active: false }))).toBe(true);
    // Every hand-built menu is the floating surface, its rows the menu row.
    const panels = [...host.querySelectorAll("div.absolute.top-full")];
    expect(panels.length).toBeGreaterThanOrEqual(3);
    for (const p of panels) expect(wears(p, modernPopover)).toBe(true);
    const rows = panels.flatMap((p) => [...p.querySelectorAll("button")]);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.some((r) => wears(r, modernMenuRow({ selected: true })))).toBe(true);
    expect(rows.some((r) => wears(r, modernMenuRow()))).toBe(true);
    await unmount();
  });
});
