import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The undo card's doorways (⌘⌥Z, the held peek, the toasts' History action)
// are installed by useGlobalShortcutActions, which DashboardLayoutInner runs
// before any of its branch returns (the guest frame, a browser pane's page,
// the main shell). A host rendered in only one branch leaves the others with
// an open card nobody can see, and an open card silences every undo toast.
// So the host renders beside DashboardLayoutInner, never inside it.
const source = readFileSync(join(import.meta.dir, "../../components/DashboardLayout.tsx"), "utf8");
const HOSTS = ["UndoTimelineHost"];

describe("hosts whose doorways run in every layout branch", () => {
  const innerStart = source.indexOf("function DashboardLayoutInner(");
  const inner = source.slice(innerStart);
  for (const host of HOSTS) {
    test(`${host} renders beside DashboardLayoutInner, in every branch`, () => {
      expect(innerStart).toBeGreaterThan(0);
      expect(inner.includes(`<${host}`)).toBe(false);
      const wrapper = source.slice(0, innerStart);
      expect(wrapper).toMatch(new RegExp(`<DashboardLayoutInner \\{\\.\\.\\.props\\} />\\s*<${host} />`));
    });
  }
});

// UndoReach mounts the card in frames outside the dashboard, whose openers
// assume the dashboard's tab shell. Each such frame says where the card's open
// acts lead (`frame=`), or is listed here as a frame whose readers all belong
// in the full app (the default acts leave for it: useOpenSession never opens
// in place outside the tab shell).
const OPENS_FULL_APP = new Set<string>();

describe("every frame that mounts UndoReach decides where its card's links go", () => {
  const root = join(import.meta.dir, "../..");
  const files = new Bun.Glob("{app,components,src}/**/*.tsx").scanSync({ cwd: root });
  for (const rel of files) {
    if (rel.includes("__tests__") || rel.endsWith(".test.tsx") || rel === "components/undo/UndoTimeline.tsx") continue;
    const src = readFileSync(join(root, rel), "utf8");
    for (const m of src.matchAll(/<UndoReach\b([^>]*)\/>/g)) {
      test(`${rel} passes a frame or opens the full app`, () => {
        expect(m[1]!.includes("frame=") || OPENS_FULL_APP.has(rel)).toBe(true);
      });
    }
  }
});
