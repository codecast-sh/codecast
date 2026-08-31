import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// FEEDER PARITY GUARD (docs/architecture/sync-convergence.md C5).
//
// `useSyncCore(profile)` owns the full feeder mount set for the session
// replica; web (DashboardLayout) and mobile (StoreSyncBridge) both mount IT,
// never a hand-picked subset. Before this, mobile mounted two of five feeders,
// so its replica computed counts from thinner data — the drift class the
// parity rule ends. Three invariants, all source-level:
//
// 1. useSyncCore mounts every core feeder.
// 2. Both platforms mount useSyncCore (and mobile wires the AppState wake
//    source into the syncWake bus — its resume catch-up pass).
// 3. The recovery probe requests the live window with the SAME args as the
//    subscription (LIST_INBOX_SESSIONS_ARGS), so a stalled subscription can
//    never flap the store between two payload shapes.
// 4. Mobile SCREENS host none of the core feeders — StoreSyncBridge is the
//    only mount, so a screen re-render can never fork the feed set.

const WEB_ROOT = join(import.meta.dir, "..", "..");
const MOBILE_ROOT = join(WEB_ROOT, "..", "mobile");

// The session-replica core: the exact mount set the contract names.
const CORE_FEEDERS = [
  "useSyncInboxSessions",   // live window + liveness overlay + recovery probes + crawls + reconciles
  "useSyncTeamInboxSessions", // team feeders per scope
  "useSyncChangeFeed",      // sync-log applier
  "useSyncSessionDecisions", // decision queue (questions input)
  "useSyncBuckets",         // labels
] as const;

function read(p: string): string {
  return readFileSync(p, "utf8");
}

function codeLines(src: string): string[] {
  return src.split("\n").filter((line) => {
    const t = line.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  });
}

describe("useSyncCore owns the full feeder mount set", () => {
  const coreSrc = read(join(WEB_ROOT, "hooks", "useSyncCore.ts"));

  test("every core feeder is mounted inside useSyncCore", () => {
    for (const feeder of CORE_FEEDERS) {
      expect(coreSrc.includes(`${feeder}();`)).toBe(true);
    }
  });

  test("web DashboardLayout mounts useSyncCore, not a subset", () => {
    const src = read(join(WEB_ROOT, "components", "DashboardLayout.tsx"));
    expect(src.includes('useSyncCore("web")')).toBe(true);
    const code = codeLines(src).join("\n");
    for (const feeder of CORE_FEEDERS) {
      expect(code.includes(`${feeder}(`)).toBe(false);
    }
  });

  test("mobile StoreSyncBridge mounts useSyncCore and wires the AppState wake source", () => {
    const src = read(join(MOBILE_ROOT, "components", "StoreSyncBridge.tsx"));
    expect(src.includes("useSyncCore('mobile')") || src.includes('useSyncCore("mobile")')).toBe(true);
    // The resume catch-up pass: AppState "active" emits on the syncWake bus.
    expect(src.includes("AppState.addEventListener")).toBe(true);
    expect(src.includes("emitSyncWake()")).toBe(true);
  });

  test("the recovery probe and the subscription share ONE args constant", () => {
    const live = read(join(WEB_ROOT, "hooks", "useLiveInboxSessions.ts"));
    expect(live.includes("export const LIST_INBOX_SESSIONS_ARGS")).toBe(true);
    expect(live.includes("useQuery(api.conversations.listInboxSessions, LIST_INBOX_SESSIONS_ARGS)")).toBe(true);
    const syncSrc = read(join(WEB_ROOT, "hooks", "useSyncInboxSessions.ts"));
    expect(syncSrc.includes("{ ...LIST_INBOX_SESSIONS_ARGS, _probe: Date.now() }")).toBe(true);
    // No hand-built listInboxSessions args anywhere in the two files: every
    // call is either the constant or the constant + probe token.
    for (const src of [live, syncSrc]) {
      for (const line of codeLines(src)) {
        if (!line.includes("listInboxSessions,")) continue;
        expect(
          line.includes("LIST_INBOX_SESSIONS_ARGS"),
        ).toBe(true);
      }
    }
  });
});

describe("mobile screens host no core feeder", () => {
  function walk(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".expo") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  test("no file under mobile app/ mounts a core feeder or useSyncCore", () => {
    const offenders: string[] = [];
    const banned = new RegExp(`\\b(${CORE_FEEDERS.join("|")}|useSyncCore|useLiveInboxSessions)\\b`);
    for (const file of walk(join(MOBILE_ROOT, "app"))) {
      const rel = file.slice(MOBILE_ROOT.length + 1);
      codeLines(read(file)).forEach((line) => {
        if (banned.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});
