// ct-102196: a priority's Polish counter ("Polish 3/4") promises every polish milestone, so opening
// it with Hide done on (the page's default) lists all four, the finished ones included. Before the
// fix the done ones stayed hidden behind the critical progress toggle, and opening Polish when its
// one open line already showed (it asks the person) changed nothing on screen.
// Run: cd packages/web && bun test --isolate components/priorities/PriorityPolish.mount.test.tsx
import { expect, test } from "bun:test";
import { installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

installDom("https://app.test/priorities");
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
await installMissingBackend({ answers: {} });
await seedViewer();

const React = await import("react");
const { block, links, mount, row, sess, step, view, FILTERS } = await import("../../test-helpers/prioritiesList");

test("opening Polish 3/4 with Hide done on lists all four polish milestones", async () => {
  expect(FILTERS.hideDone).toBe(true);
  const pri = row(7, "Polish counter", 1, [
    step("s1", "Ship it", "critical"),
    step("p1", "Tidy the copy", "polish"),
    step("p2", "Done polish A", "polish", true),
    step("p3", "Done polish B", "polish", true),
    step("p4", "Done polish C", "polish", true),
  ], {
    links: [links("s1", [sess("polshp", "Ship session", "dormant", 2)]), links("p1", [sess("polask", "Copy review", "needs_you", 1)]), links("p2", []), links("p3", []), links("p4", [])],
  });
  const page = await mount(view({ rows: [pri] }));
  const { act } = React as any;
  try {
    const b = block(page.container, "pri-7");
    const toggle = b.querySelector("[data-polish]") as HTMLElement;
    expect(toggle.textContent).toContain("3/4");
    const shown = () => [...b.querySelectorAll("[data-milestone]")].map((n) => n.getAttribute("data-milestone")).filter((k) => k!.startsWith("p"));
    // Collapsed: only the asking line.
    expect(shown()).toEqual(["p1"]);
    await act(async () => { toggle.click(); });
    // Open: everything the counter counted.
    expect(shown().sort()).toEqual(["p1", "p2", "p3", "p4"]);
  } finally {
    await page.unmount();
  }
}, 60_000);
