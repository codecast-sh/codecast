// A priority's DONE and POLISH heads (components/priorities/PriorityBlock
// Milestones), mounted in jsdom over the list's fixtures. Proves: opening or
// closing a section from the keyboard keeps focus on the head that was
// pressed, the very same element (never remounted), so the next Space or
// Enter acts again; for Done, and for Polish with Done open and closed.
// Run: cd packages/web && bun test --isolate components/priorities/PrioritySections.mount.test.tsx
import { expect, test } from "bun:test";
import { installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

installDom("https://app.test/priorities");
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { act } = React as any;
const { DAY, NOW, block, mount, row, step, view } = await import("../../test-helpers/prioritiesList");

const r = row(21, "Sections", 1, [
  step("s1", "Open one", "critical"),
  step("s2", "Landed one", "critical", true, { done_at: NOW - DAY }),
  step("p1", "Polish open", "polish"),
], { links: [] });

/** A keyboard press on a focused button: the key, then the click a browser sends for Enter or Space. */
const press = (el: HTMLElement, key: "Enter" | " ") => act(async () => {
  el.dispatchEvent(new (window as any).KeyboardEvent("keydown", { key, bubbles: true }));
  el.click();
});

test("Enter on DONE opens it and focus stays on that same head; Space then closes it", async () => {
  const page = await mount(view({ rows: [r] }));
  try {
    const b = block(page.container, "pri-21");
    const done = b.querySelector('[data-section="done"]') as HTMLElement;
    done.focus();
    await press(done, "Enter");
    expect(b.querySelector('[data-section-open="done"]')).not.toBeNull();
    expect(b.querySelector('[data-section="done"]')).toBe(done);
    expect(document.activeElement).toBe(done);
    await press(done, " ");
    expect(b.querySelector('[data-section-open="done"]')).toBeNull();
    expect(document.activeElement).toBe(done);
  } finally {
    await page.unmount();
  }
}, 60_000);

test("POLISH keeps focus too, with DONE closed and with DONE open", async () => {
  const page = await mount(view({ rows: [r] }));
  try {
    const b = block(page.container, "pri-21");
    const polish = b.querySelector('[data-section="polish"]') as HTMLElement;
    // Done closed: Polish leaves the shared line for its own.
    polish.focus();
    await press(polish, "Enter");
    expect(b.querySelector('[data-section-open="polish"]')).not.toBeNull();
    expect(document.activeElement).toBe(polish);
    await press(polish, " ");
    expect(document.activeElement).toBe(polish);
    // Done open: Polish opens and closes below it.
    const done = b.querySelector('[data-section="done"]') as HTMLElement;
    done.focus();
    await press(done, "Enter");
    expect(document.activeElement).toBe(done);
    polish.focus();
    await press(polish, "Enter");
    expect(b.querySelector('[data-section-open="polish"]')).not.toBeNull();
    expect(b.querySelector('[data-section="polish"]')).toBe(polish);
    expect(document.activeElement).toBe(polish);
    await press(polish, " ");
    expect(b.querySelector('[data-section-open="polish"]')).toBeNull();
    expect(document.activeElement).toBe(polish);
  } finally {
    await page.unmount();
  }
}, 60_000);
