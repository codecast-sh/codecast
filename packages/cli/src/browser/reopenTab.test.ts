import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reopenBrowserTab, reopenIdentityEnv, type ReopenDeps } from "./reopenTab.js";
import { engineSessionKey, realSessionKey } from "./engine.js";
import { parseTabLine, tabLine } from "./tabId.js";

const UUID = "b8d22068-256b-42ee-92ef-f97599b89516";
const T1 = "2BE86883491FD502B8D986C164423006";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reopen-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function pin(key: string, targetId: string, ageMs = 0): void {
  const file = path.join(dir, `${key}.target`);
  fs.writeFileSync(file, JSON.stringify({ targetId, url: "about:blank", pinned: true }));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

describe("parseTabLine", () => {
  test("reads back what tabLine prints, last mention wins, flags excluded", () => {
    expect(parseTabLine(tabLine(T1, "next: cast browser snapshot"))).toBe("2BE86883");
    expect(parseTabLine("tab 11111111\n…\ntab 22222222 — next: x")).toBe("22222222");
    expect(parseTabLine("try: cast browser close --tab 4A2CDC7E")).toBeNull();
    expect(parseTabLine("")).toBeNull();
  });
});

describe("reopenIdentityEnv", () => {
  const candidates = [`session:${UUID}`, `env:${UUID}`, "pane:%7"];

  test("no pin anywhere: the first candidate stands, as its env twin", () => {
    expect(reopenIdentityEnv(candidates, dir)).toEqual({ CAST_SESSION_ID: UUID });
    expect(reopenIdentityEnv(["pane:%7"], dir)).toEqual({ TMUX_PANE: "%7" });
    expect(reopenIdentityEnv([], dir)).toBeNull();
  });

  test("the candidate with the newest target file wins", () => {
    pin(engineSessionKey(`env:${UUID}`), T1, 60_000);
    pin(engineSessionKey("pane:%7"), T1, 0);
    expect(reopenIdentityEnv(candidates, dir)).toEqual({ TMUX_PANE: "%7" });
  });

  test("a real-Chrome pin counts for its candidate too", () => {
    pin(realSessionKey(engineSessionKey("pane:%7")), T1);
    expect(reopenIdentityEnv(candidates, dir)).toEqual({ TMUX_PANE: "%7" });
  });
});

describe("reopenBrowserTab", () => {
  function deps(run: Partial<{ status: number; stdout: string; stderr: string }>, seen: { url?: string; identity?: Record<string, string> } = {}): ReopenDeps {
    return {
      stateDir: dir,
      runOpen: async (url, identity) => {
        seen.url = url;
        seen.identity = identity;
        return { status: 0, stdout: "", stderr: "", ...run };
      },
    };
  }

  test("opens as the session and returns the tab the CLI printed", async () => {
    const seen: { url?: string; identity?: Record<string, string> } = {};
    const result = await reopenBrowserTab(
      { url: "https://example.com/x", candidates: [`env:${UUID}`] },
      deps({ stdout: `Example\nhttps://example.com/x\n${tabLine(T1)}\n` }, seen),
    );
    expect(result).toEqual({ ok: true, tabId: "2BE86883" });
    expect(seen).toEqual({ url: "https://example.com/x", identity: { CAST_SESSION_ID: UUID } });
  });

  test("a failed open reports its last line, never a tab", async () => {
    const result = await reopenBrowserTab(
      { url: "https://example.com", candidates: ["pane:%3"] },
      deps({ status: 1, stderr: "\x1b[31mopen refused: site is walled off\x1b[0m\n" }),
    );
    expect(result).toEqual({ ok: false, reason: "open-failed", detail: "open refused: site is walled off" });
  });

  test("an open that exits clean without naming a tab is still a failure", async () => {
    const result = await reopenBrowserTab({ url: "https://example.com", candidates: ["pane:%3"] }, deps({ stdout: "nothing\n" }));
    expect(result).toMatchObject({ ok: false, reason: "open-failed" });
  });

  test("refuses a non-http url and a request with no session", async () => {
    let ran = false;
    const d: ReopenDeps = { stateDir: dir, runOpen: async () => ((ran = true), { status: 0, stdout: "", stderr: "" }) };
    expect(await reopenBrowserTab({ url: "javascript:alert(1)", candidates: ["pane:%3"] }, d)).toMatchObject({ ok: false, reason: "bad-request" });
    expect(await reopenBrowserTab({ url: "https://example.com", candidates: [] }, d)).toMatchObject({ ok: false, reason: "bad-request" });
    expect(ran).toBe(false);
  });
});
