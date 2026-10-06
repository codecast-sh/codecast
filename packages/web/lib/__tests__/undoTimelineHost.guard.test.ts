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
