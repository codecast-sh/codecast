import { describe, expect, test } from "bun:test";
import { DEV_SURFACES, DEVELOPER_MODE, MODE_WORDS, modePageLabel, pageSurface, shownFor, surfaceMode, type DevSurface } from "../surfaceRules";
import { NAV_PAGES, pagePath, palettePages } from "../navPages";
import { isHostedUi } from "../../components/simple/lanePaths";
import { modePathLabel, pathLabel } from "../pathLabel";
import { tabTitle } from "../tabTitle";
import { isHostedMode, surfaceShown } from "../surfaces";
import { resolveInboxCompact, resolveSimpleView, resolveVisualStyle } from "../../store/inboxStore";
import { paletteActions } from "../paletteActions";

const ALL = Object.keys(DEV_SURFACES) as DevSurface[];
const state = (lane: string | undefined, machines: number, live = true) => ({
  clientState: { ui: lane ? { lane } : {} },
  machineRoster: Array.from({ length: machines }, (_, i) => ({ id: i })),
  machineRosterLive: live,
});

describe("hosted mode surface registry", () => {
  test("developer mode shows every surface, with or without a machine", () => {
    for (const name of ALL) {
      expect(surfaceShown(state(undefined, 0), name)).toBe(true);
      expect(surfaceShown(state("full", 2), name)).toBe(true);
    }
    expect(isHostedMode(state("full", 0))).toBe(false);
  });

  test("hosted mode hides every developer surface", () => {
    for (const name of ALL) {
      if (DEV_SURFACES[name] === "developer") expect(surfaceShown(state("simple", 3), name)).toBe(false);
    }
    expect(isHostedMode(state("simple", 0))).toBe(true);
  });

  test("hosted mode keeps machine settings for an account that runs a machine", () => {
    expect(surfaceShown(state("simple", 1), "settings.machines")).toBe(true);
    expect(surfaceShown(state("simple", 0), "settings.machines")).toBe(false);
    // A roster that has not answered is never read as "no machine".
    expect(surfaceShown(state("simple", 0, false), "settings.machines")).toBe(true);
  });

  test("the gated places named in the spec each have a rule", () => {
    for (const name of [
      "nav.changes", "nav.projects", "nav.code", "nav.files", "nav.line", "nav.ops", "nav.windows",
      "banner.setup", "banner.cliOffline", "banner.tmuxMissing", "banner.deviceSetup", "banner.resourcePressure",
      "terminal", "diff", "gitChips", "machineChips", "modelPicker", "settings.machines", "empty.installCli", "tour.agentInbox",
    ]) expect(Object.hasOwn(DEV_SURFACES, name)).toBe(true);
  });

  test("a pure view's mode reads the same rule and the hosted words", () => {
    expect(surfaceMode(false, true)).toBe(DEVELOPER_MODE);
    const hosted = surfaceMode(true, false);
    for (const name of ALL) expect(hosted.shows(name)).toBe(shownFor(true, false, name));
    expect(hosted.words).toEqual(MODE_WORDS.hosted);
    expect(hosted.words.newConversation).toBe("New conversation");
    expect(hosted.words.triggers).toBe("Routines");
  });
});

describe("hosted mode implies the calm presentation", () => {
  test("Minimal style, Simple view and the compact list, over any stored pick", () => {
    const ui = { lane: "simple", visual_style: "classic" as const, simple_view: false, inbox_compact: false };
    expect(resolveVisualStyle(ui)).toBe("minimal");
    expect(resolveSimpleView(ui)).toBe(true);
    expect(resolveInboxCompact(ui)).toBe(true);
  });

  test("leaving hosted mode restores the stored picks", () => {
    const ui = { lane: "full", visual_style: "classic" as const, simple_view: false };
    expect(resolveVisualStyle(ui)).toBe("classic");
    expect(resolveSimpleView(ui)).toBe(false);
    expect(resolveInboxCompact(ui)).toBe(false);
  });
});

describe("one hosted-mode predicate", () => {
  test("isHostedUi reads the lane, and isHostedMode reads it from state", () => {
    expect(isHostedUi({ lane: "simple" })).toBe(true);
    for (const ui of [undefined, null, {}, { lane: "full" }]) expect(isHostedUi(ui)).toBe(false);
    expect(isHostedMode({ clientState: { ui: { lane: "simple" } } } as any)).toBe(true);
  });
});

describe("a page named by a mode word", () => {
  test("the triggers page is Routines in hosted mode, Triggers otherwise", () => {
    expect(modePageLabel("/triggers?new=1", true)).toBe("Routines");
    expect(modePageLabel("/triggers", false)).toBe("Triggers");
    expect(modePageLabel("/tasks", true)).toBeNull();
    expect(pathLabel("/triggers")).toBe("Triggers");
    expect(pathLabel("/triggers", { lane: "simple" })).toBe("Routines");
    expect(modePathLabel("/triggers", { lane: "simple" })).toBe("Routines");
    expect(modePathLabel("/tasks", { lane: "simple" })).toBeNull();
  });

  test("a rail row reads the same map through the mode's page()", () => {
    expect(surfaceMode(true, false).page("/triggers", "Triggers")).toBe("Routines");
    expect(DEVELOPER_MODE.page("/triggers", "Triggers")).toBe("Triggers");
    expect(surfaceMode(true, false).page("/tasks", "Tasks")).toBe("Tasks");
  });

  test("the routines page's developer filters and machinery are developer surfaces", () => {
    for (const name of ["triggers.devFilters", "triggers.internals"] as const) {
      expect(shownFor(true, false, name)).toBe(false);
      expect(shownFor(false, true, name)).toBe(true);
    }
    expect(MODE_WORDS.hosted.freshPerRun).not.toMatch(/session/i);
    expect(MODE_WORDS.hosted.skippedRun).not.toMatch(/skip|precheck/i);
  });

  test("no hosted word names the developer machinery", () => {
    for (const [key, word] of Object.entries(MODE_WORDS.hosted)) {
      expect({ key, word }).toEqual({ key, word: expect.not.stringMatching(/session|precheck|skip|trigger|agent|daemon|prompt/i) });
    }
  });

  test("the routine form's developer rows are a developer surface", () => {
    expect(shownFor(true, false, "triggers.devForm")).toBe(false);
    expect(shownFor(false, true, "triggers.devForm")).toBe(true);
  });

  test("a tab reads the mode now, over the title stamped when it opened", () => {
    const tab = { id: "t", path: "/triggers", title: "triggers", createdAt: 0 };
    expect(tabTitle(tab, {}, {}, undefined, undefined, undefined, undefined, { clientState: { ui: { lane: "simple" } } })).toBe("Routines");
    expect(tabTitle(tab, {}, {}, undefined, undefined, undefined, undefined, { clientState: { ui: {} } })).toBe("Triggers");
  });
});

describe("palette verbs follow the registry", () => {
  const session = { _id: "s1", user_id: "me", agent_type: "claude_code", message_count: 3, title: "x", model: "claude-opus-4-1", session_id: "u1" };
  test("hosted mode drops the model and machine verbs from a local session", () => {
    const dev = paletteActions("session", [session], "me", true).map((a) => a.key);
    const hosted = paletteActions("session", [session], "me", true, surfaceMode(true, false)).map((a) => a.key);
    expect(dev).toContain("device");
    expect(hosted).not.toContain("device");
    expect(hosted).not.toContain("model");
    expect(hosted).toEqual(expect.arrayContaining(["rename", "session_pin"]));
  });
});

describe("pages belong to surfaces", () => {
  test("a page and everything under it share its surface; the longest match wins", () => {
    expect(pageSurface("/ops")).toBe("nav.ops");
    expect(pageSurface("/ops/issues?x=1")).toBe("nav.ops");
    expect(pageSurface("/line/settings")).toBe("nav.line");
    expect(pageSurface("/changes?d=2026-10-05")).toBe("nav.changes");
    expect(pageSurface("/settings/devices")).toBe("settings.machines");
    expect(pageSurface("/settings")).toBeNull();
    expect(pageSurface("/settings/notifications")).toBeNull();
    expect(pageSurface("/inbox")).toBeNull();
    expect(pageSurface("/")).toBeNull();
  });

  test("hosted mode's palette lists no page whose surface it hides", () => {
    const allOn = () => true;
    for (const noMachine of [true, false]) {
      const mode = surfaceMode(true, noMachine);
      const rows = palettePages(mode, allOn, true);
      for (const { page } of rows) {
        const surface = pageSurface(pagePath(page));
        if (surface) expect({ page: page.label, shown: mode.shows(surface) }).toEqual({ page: page.label, shown: true });
      }
      const labels = rows.map((r) => r.label);
      for (const hidden of ["Changes", "Changes: risks only", "Code", "Files", "Ops", "Ops: issues", "Workflows", "Line", "Line settings", "Evals", "Memory"]) {
        expect(labels).not.toContain(hidden);
      }
      expect(labels).toEqual(expect.arrayContaining(["Inbox", "Tasks", "Documents", "Routines", "Pages", "Search", "Settings"]));
    }
    // An account in hosted mode that runs a machine still reaches its pages.
    expect(palettePages(surfaceMode(true, false), allOn, true).map((r) => r.label)).toContain("Devices");
    expect(palettePages(surfaceMode(true, true), allOn, true).map((r) => r.label)).not.toContain("Devices");
  });

  test("developer mode lists every page its features allow", () => {
    expect(palettePages(DEVELOPER_MODE, () => true, true)).toHaveLength(NAV_PAGES.length);
    expect(palettePages(DEVELOPER_MODE, () => true, false).every(({ page }) => !page.secondary)).toBe(true);
    expect(palettePages(DEVELOPER_MODE, (f) => f !== "changes", true).map((r) => r.label)).not.toContain("Changes");
  });
});
