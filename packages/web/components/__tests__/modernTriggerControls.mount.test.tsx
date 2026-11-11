// The Triggers page in the Modern style: the type filters are chips, the
// overview's counts toggle as chips, the search is the text field, and the
// empty filter result's button is the outline button. Classic draws exactly
// the classes it drew before the Modern looks (the snapshot was taken from the
// unmodified page; `modern:` classes are left out of it).
import { describe, expect, mock, test } from "bun:test";
import { installModernDom, styleValue, classicClasses, wears } from "../../test-helpers/modernDom";

installModernDom("https://app.test/triggers");

const NOW = Date.now();
const triggers = [
  { _id: "tr1", short_id: "tr-1", title: "Nightly digest", prompt: "Summarise the day", schedule_type: "recurring", interval_ms: 86_400_000, status: "scheduled", next_run_at: NOW + 3_600_000, created_at: NOW - 86_400_000, updated_at: NOW - 3_600_000, project_path: "/Users/a/src/codecast", agent_type: "claude_code", mode: "apply" },
  { _id: "tr2", short_id: "tr-2", title: "Check the deploy", prompt: "Is it green?", schedule_type: "once", status: "scheduled", next_run_at: NOW + 600_000, created_at: NOW - 60_000, updated_at: NOW - 60_000, project_path: "/Users/a/src/web", agent_type: "codex", mode: "propose" },
];
const realTriggers = { ...(await import("../../hooks/useSyncTriggers")) };
mock.module("../../hooks/useSyncTriggers", () => ({ ...realTriggers, useTriggers: () => ({ tasks: triggers, ready: true }) }));
const realAuth = { ...(await import("../AuthGuard")) };
mock.module("../AuthGuard", () => ({ ...realAuth, AuthGuard: ({ children }: any) => children }));
const realLayout = { ...(await import("../DashboardLayout")) };
mock.module("../DashboardLayout", () => ({ ...realLayout, DashboardLayout: ({ children }: any) => children }));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { offlineConvexClient } = await import("../../test-helpers/offlineConvex");
const { ThemeContext } = await import("../ThemeProvider");
const { default: TriggersPage } = await import("../../app/triggers/page");
const { modernChip, modernField } = await import("../ui/modernLook");

const convex = offlineConvexClient();

async function render(style: "classic" | "modern") {
  document.documentElement.classList.toggle("modern-style", style === "modern");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <ConvexProvider client={convex}>
      <ThemeContext.Provider value={styleValue(style)}>
        <MemoryRouter initialEntries={["/triggers"]}><TriggersPage /></MemoryRouter>
      </ThemeContext.Provider>
    </ConvexProvider>,
  ));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  // The type filters (the SegmentedToggle's own buttons say aria-pressed too).
  const pressed = [...host.querySelectorAll("button[aria-pressed]")].filter((b) => !b.closest(".h-6, .h-7") && b.querySelector("svg"));
  return { host, pressed, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

describe("the Triggers page in Modern", () => {
  test("Classic draws the classes it drew before the Modern looks", async () => {
    const { host, pressed, unmount } = await render("classic");
    expect(pressed.length).toBeGreaterThanOrEqual(2);
    expect(host.querySelector("#trigger-search")).not.toBeNull();
    expect(classicClasses(host)).toMatchSnapshot();
    await unmount();
  });

  test("the type filters are chips and the search is the text field", async () => {
    const { host, pressed, unmount } = await render("modern");
    for (const b of pressed) expect(wears(b, modernChip({ active: b.getAttribute("aria-pressed") === "true" }))).toBe(true);
    expect(wears(host.querySelector("#trigger-search"), modernField)).toBe(true);
    await unmount();
  });
});
