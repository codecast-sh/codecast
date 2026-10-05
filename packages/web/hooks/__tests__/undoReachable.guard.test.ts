// Every window either reaches its undo history or records none
// (hooks/useUndoUnreachable). The undo history is in memory per window, and
// only the dashboard mounts a way back (useUndoWalk's ⌘Z, the timeline, a
// toast the window can click). An auxiliary Electron window that records
// strands its entries: a kill from the agent dock looked undoable, its toast
// sat outside the dock's clickable region, and ⌘Z in the main window took
// back an unrelated older entry.
//
// The windows are read from the shell (electron/main.js loads each by URL),
// their pages from the router (src/App.tsx). A window's page must mount
// useUndoUnreachable, through TransparentWindowLayout or on its own, or the
// dashboard.
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");

const MAIN_WINDOW_PATHS = new Set(["inbox"]);

function auxiliaryWindowPaths(): string[] {
  const main = read("../electron/main.js");
  const paths = new Set<string>();
  for (const m of main.matchAll(/loadURL\(`\$\{currentBaseUrl\}\/([a-z][a-z-]*)`\)/g)) paths.add(m[1]!);
  const people = main.match(/const PEOPLE_PATH = "\/([a-z-]+)"/);
  if (people && /loadURL\(`\$\{currentBaseUrl\}\$\{PEOPLE_PATH\}`\)/.test(main)) paths.add(people[1]!);
  if (/loadURL\(callPanelUrl\(/.test(main)) paths.add("call-panel");
  return [...paths].filter((p) => !MAIN_WINDOW_PATHS.has(p)).sort();
}

const holdsUndoAway = (source: string) => /\buseUndoUnreachable\(\)/.test(source);
const reachesUndo = (source: string) => /\buseUndoWalk\(\)|<DashboardLayout\b/.test(source);
/** A shell inside the main window reaches its history only with both halves:
 *  the keys (useUndoWalk) and the card the toasts' History opens. */
const mountsUndoReach = (source: string) => /<DashboardLayout\b|<UndoReach\b/.test(source) || (/\buseUndoWalk\(\)/.test(source) && /<UndoTimelineHost\b/.test(source));

describe("every window reaches its undo history or records none", () => {
  const app = read("src/App.tsx");
  const transparent = app.match(/<Route element=\{<TransparentWindowLayout \/>\}>([\s\S]*?)<\/Route>/)?.[1] ?? "";
  const inTransparent = new Set([...transparent.matchAll(/path="([^"]+)"/g)].map((m) => m[1]!));

  it("finds the shell's auxiliary windows and the transparent layout", () => {
    expect(auxiliaryWindowPaths().length).toBeGreaterThanOrEqual(6);
    expect(inTransparent.size).toBeGreaterThan(0);
  });

  it("the transparent window layout records none", () => {
    expect(holdsUndoAway(read("src/layouts/TransparentWindowLayout.tsx"))).toBe(true);
  });

  for (const path of auxiliaryWindowPaths()) {
    it(`/${path}`, () => {
      if (inTransparent.has(path)) return;
      const route = app.match(new RegExp(`<Route path="${path}" element=\\{<E name="(\\w+)">`));
      expect(route, `no route for the /${path} window in src/App.tsx`).toBeTruthy();
      const name = route![1]!;
      const lazy = app.match(new RegExp(`const ${name} = lazy\\(\\(\\) => import\\("@/([^"]+)"\\)\\)`));
      expect(lazy, `no lazy import for ${name} in src/App.tsx`).toBeTruthy();
      const page = read(`${lazy![1]}.tsx`);
      expect(holdsUndoAway(page) || reachesUndo(page), `/${path} records undo history it cannot reach: mount useUndoUnreachable()`).toBe(true);
    });
  }
});

// The main window has route shells of its own (src/App.tsx layout routes):
// the dashboard, settings, the simple lane, the marketing pages. Each shell is
// a different place to stand, and a shell with no ⌘Z and no card strands what
// it records just as an auxiliary window does.
describe("every route shell in the main window reaches its undo history or records none", () => {
  const app = read("src/App.tsx");
  const shells = new Set<string>();
  for (const m of app.matchAll(/<Route(?:\s+path="[^"]*")?\s+element=\{<(\w+)\s*\/>\}>/g)) shells.add(m[1]!);

  function sourceOf(name: string): string {
    const lazy = app.match(new RegExp(`const ${name} = lazy\\(\\(\\) => import\\("\\./([^"]+)"\\)\\)`));
    const named = app.match(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./([^"]+)"`));
    const dflt = app.match(new RegExp(`import ${name} from "\\./([^"]+)"`));
    const rel = lazy?.[1] ?? named?.[1] ?? dflt?.[1];
    expect(rel, `no import for the ${name} shell in src/App.tsx`).toBeTruthy();
    return read(`src/${rel}.tsx`);
  }

  it("finds the layout shells", () => {
    expect([...shells]).toEqual(expect.arrayContaining(["DashboardShell", "SimpleShell", "TransparentWindowLayout", "SettingsLayout", "MarketingLayout"]));
  });

  for (const name of [...shells].sort()) {
    it(name, () => {
      const src = sourceOf(name);
      expect(holdsUndoAway(src) || mountsUndoReach(src), `${name} records undo history it cannot reach: mount useUndoWalk() and <UndoTimelineHost />, or useUndoUnreachable()`).toBe(true);
    });
  }
});

// The class closes by construction: the app's boot arms a gate that keeps
// recording off, and only a mounted reach (useUndoWalk) opens it. So a page
// outside every layout route that picks its own frame at runtime (the /r
// repository pages, the share pages, review) records nothing unless it mounts
// a reach, and no route list has to remember it.
describe("a window records undo history only while a reach is mounted", () => {
  it("the app boot arms the gate", () => {
    expect(read("src/boot.tsx")).toMatch(/^recordUndoOnlyWhereReachable\(\);/m);
  });

  it("the walk holds the reach while mounted", () => {
    expect(read("hooks/useUndoWalk.ts")).toMatch(/\buseUndoReach\(\);/);
  });

  it("UndoReach mounts both halves", () => {
    const src = read("components/undo/UndoTimeline.tsx");
    const body = src.match(/export function UndoReach\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(body).toMatch(/\buseUndoWalk\(\)/);
    expect(body).toMatch(/<UndoTimelineHost\b/);
  });

  it("the standalone repository frame reaches its history for a signed-in reader", () => {
    const src = read("components/repo/RepoPageShell.tsx");
    const standalone = src.match(/function StandaloneRepoShell\b([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(standalone).toMatch(/<UndoReach\b/);
  });

  it("nothing outside the gate turns window-wide recording on or off", () => {
    const offenders: string[] = [];
    const walkDir = (dir: string) => {
      for (const name of readdirSync(join(WEB, dir))) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const rel = join(dir, name);
        if (statSync(join(WEB, rel)).isDirectory()) { walkDir(rel); continue; }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.|__tests__/.test(rel)) continue;
        if (rel === join("hooks", "useUndoUnreachable.ts")) continue;
        if (/\bsuspendUndoRecording\b|\bholdUndoReach\b/.test(read(rel))) offenders.push(rel);
      }
    };
    for (const dir of ["app", "components", "hooks", "lib", "src", "store", "shortcuts"]) walkDir(dir);
    expect(offenders).toEqual([]);
  });
});
