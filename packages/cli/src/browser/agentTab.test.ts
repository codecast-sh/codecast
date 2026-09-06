import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentTabInitScript } from "./engine.js";
import { AGENT_TAB_EVENT, AGENT_TAB_KEY, agentTabStampSource, recorderSource } from "./observe.js";

// The stamp tells a codecast page that an agent drives the tab, so the
// desktop hand-off gate neither holds it nor hands it off
// (packages/web/lib/desktopHandoff.ts). It must run before any page script,
// in every driver: the recorder carries it for the built-in driver and the
// resident host, the engine gets it as an init script.
describe("agent-tab stamp", () => {
  test("writes the gate's key and fires its event, and survives a page with no storage", () => {
    const src = agentTabStampSource();
    expect(src).toContain(`sessionStorage.setItem(${JSON.stringify(AGENT_TAB_KEY)}, "1")`);
    expect(src).toContain(`document.dispatchEvent(new Event(${JSON.stringify(AGENT_TAB_EVENT)}))`);
    // Both writes are guarded: an opaque origin throws on sessionStorage.
    expect(src.match(/try \{/g)?.length).toBe(2);
  });

  test("the recorder stamps the tab before it installs itself", () => {
    const src = recorderSource();
    expect(src.indexOf(agentTabStampSource())).toBe(0);
    expect(src.indexOf("window.__cast")).toBeGreaterThan(0);
  });

  test("the engine init script is written once and keeps a stable path across calls", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-engine-"));
    try {
      const first = agentTabInitScript(home);
      expect(fs.readFileSync(first, "utf-8")).toBe(agentTabStampSource());
      const before = fs.statSync(first).mtimeMs;
      // Unchanged source: no rewrite, same path — runEngine's flags must not vary.
      expect(agentTabInitScript(home)).toBe(first);
      expect(fs.statSync(first).mtimeMs).toBe(before);
      // A stale file is brought up to date.
      fs.writeFileSync(first, "// old");
      expect(agentTabInitScript(home)).toBe(first);
      expect(fs.readFileSync(first, "utf-8")).toBe(agentTabStampSource());
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
