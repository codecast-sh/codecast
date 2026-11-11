// The Sessions page in the Modern style: its two filter strips (liveness and
// triage) are the segmented tray, the sort field and direction button wear the
// field and button looks, and the process facts stay mono but quiet. Classic
// draws exactly the classes it drew before the Modern looks (the snapshot was
// taken from the unmodified page; `modern:` classes are left out of it).
import { describe, expect, mock, test } from "bun:test";
import { installModernDom, styleValue, classicClasses, wears } from "../../test-helpers/modernDom";

installModernDom("https://app.test/sessions");

const NOW = Date.now();
const rows = [
  { _id: "ms1", session_id: "s-1", tmux_session: "cc-alpha", agent_status: "working", last_heartbeat: NOW - 1_000, started_at: NOW - 3_600_000, current_memory: 300 * 1024 * 1024, current_cpu: 12.5, current_pid_count: 4, project_path: "/Users/a/src/codecast", git_branch: "main" },
  { _id: "ms2", session_id: "s-2", tmux_session: "cc-beta", agent_status: "idle", last_heartbeat: NOW - 2_000, started_at: NOW - 7_200_000, awake_idle_ms: 3 * 3_600_000, project_path: "/Users/a/src/web" },
];
const realManaged = { ...(await import("../../hooks/useSyncManagedSessions")) };
mock.module("../../hooks/useSyncManagedSessions", () => ({
  ...realManaged,
  useManagedSessions: () => ({ sessions: rows, ready: true }),
  useAggregateMetrics: () => ({ metrics: null, ready: true }),
}));

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { offlineConvexClient } = await import("../../test-helpers/offlineConvex");
const { ThemeContext } = await import("../ThemeProvider");
const { SessionsView } = await import("../../app/sessions/page");
const { modernButton, modernField, modernTab, modernTabList } = await import("../ui/modernLook");

const convex = offlineConvexClient();

async function render(style: "classic" | "modern") {
  document.documentElement.classList.toggle("modern-style", style === "modern");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <ConvexProvider client={convex}>
      <ThemeContext.Provider value={styleValue(style)}>
        <MemoryRouter initialEntries={["/sessions"]}><SessionsView /></MemoryRouter>
      </ThemeContext.Provider>
    </ConvexProvider>,
  ));
  const strips = [...host.querySelectorAll("div.flex.flex-wrap.rounded-md.overflow-hidden")];
  return { host, strips, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

describe("the Sessions page in Modern", () => {
  test("Classic draws the classes it drew before the Modern looks", async () => {
    const { host, strips, unmount } = await render("classic");
    expect(strips.length).toBe(2);
    expect(classicClasses(host)).toMatchSnapshot();
    await unmount();
  });

  test("the filter strips are the segmented tray, the sort controls the field and button", async () => {
    const { host, strips, unmount } = await render("modern");
    for (const strip of strips) {
      expect(wears(strip, modernTabList)).toBe(true);
      const tabs = [...strip.querySelectorAll("button")];
      expect(tabs.length).toBeGreaterThanOrEqual(5);
      // "All" is the open tab in both strips, sans in Modern.
      expect(wears(tabs[0], modernTab({ active: true }))).toBe(true);
      expect(wears(tabs[1], modernTab({ active: false }))).toBe(true);
      expect(tabs[0].className).toContain("modern:font-sans");
    }
    expect(wears(host.querySelector("select"), modernField)).toBe(true);
    const dir = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.startsWith("Sort "));
    expect(wears(dir, modernButton({ variant: "outline", size: "icon-sm" }))).toBe(true);
    await unmount();
  });
});
