import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MOBILE_ROOT, WEB_ROOT, codeLines as codeLinesOf, walkSources } from "./sourceWalk";

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
// 5. DERIVED, not hand-listed: every hook under hooks/ that subscribes to a
//    session-replica CHANNEL (the query names below) is reachable from
//    useSyncCore's import closure, and no mobile file subscribes to one
//    directly. A new session feeder that useSyncCore forgets to mount fails
//    here before it can fork the replica between platforms.

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
  return codeLinesOf(src).map((l) => l.line);
}

describe("useSyncCore owns the full feeder mount set", () => {
  const coreSrc = read(join(WEB_ROOT, "hooks", "useSyncCore.ts"));

  test("every core feeder is mounted inside useSyncCore", () => {
    for (const feeder of CORE_FEEDERS) {
      expect(coreSrc.includes(`${feeder}();`)).toBe(true);
    }
  });

  test("the anti-entropy loop is part of the profile — every platform compares (sync-convergence C6)", () => {
    expect(coreSrc.includes("useInboxDigestCompare();")).toBe(true);
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
    // The one sanctioned args shape, now behind the sync-role gate: the
    // constant when this window hosts its own feeds, "skip" as a follower
    // (docs/architecture/sync-host.md).
    expect(live.includes('useQuery(api.conversations.listInboxSessions, isSyncHost ? LIST_INBOX_SESSIONS_ARGS : "skip")')).toBe(true);
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
  test("no file under mobile app/ mounts a core feeder or useSyncCore", () => {
    const offenders: string[] = [];
    const banned = new RegExp(`\\b(${CORE_FEEDERS.join("|")}|useSyncCore|useLiveInboxSessions)\\b`);
    for (const file of walkSources(join(MOBILE_ROOT, "app"))) {
      const rel = file.slice(MOBILE_ROOT.length + 1);
      codeLines(read(file)).forEach((line) => {
        if (banned.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});

// The session-replica channels (sync-convergence C1): the live window, the
// liveness overlay and their team twins, the paged/by-id hydration and the
// hide-state reconciles, the sync-log applier, the decision queue, labels,
// the current user. A hook that calls any of these FEEDS the replica.
const SESSION_REPLICA_CHANNELS = [
  "conversations.listInboxSessions",
  "conversations.sessionsLiveness",
  "conversations.listTeamInboxSessions",
  "conversations.teamSessionsLiveness",
  "conversations.listInboxSessionsPaginated",
  "conversations.getInboxSessionsByIds",
  "conversations.listDismissedSessionsLite",
  "conversations.listStashedSessionsLite",
  "syncLog.getHeads",
  "syncLog.getRange",
  "sessionDecisions.listForUser",
  "buckets.webList",
  "users.getCurrentUser",
  "users.getCurrentUserProbe",
] as const;

// The SUBSCRIPTION subset: a mobile surface may read the current user or
// hydrate a named id one-shot, but it must never open its own live window,
// overlay, sync-log, decision or label subscription — those feed the replica
// through useSyncCore only.
const SESSION_REPLICA_SUBSCRIPTIONS = SESSION_REPLICA_CHANNELS.filter(
  (ch) => !ch.startsWith("users.") && ch !== "conversations.getInboxSessionsByIds" && ch !== "conversations.listInboxSessionsPaginated",
);

function usesChannel(src: string, channels: readonly string[] = SESSION_REPLICA_CHANNELS): string[] {
  const code = codeLines(src).join("\n");
  return channels.filter((ch) => code.includes(`api.${ch}`));
}

// Files reachable from a root through RELATIVE imports inside hooks/ (the
// feeders compose each other: useSyncInboxSessions mounts useLiveInboxSessions
// and useRecoveryPoll). Store/lib modules are not feeders and are not walked.
function hookClosure(rootRel: string): Set<string> {
  const seen = new Set<string>();
  const stack = [rootRel];
  while (stack.length) {
    const rel = stack.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src: string;
    try {
      src = read(join(WEB_ROOT, "hooks", rel));
    } catch {
      continue;
    }
    for (const m of src.matchAll(/from\s+["']\.\/([^"']+)["']/g)) {
      const base = m[1].replace(/\.tsx?$/, "");
      for (const ext of [".ts", ".tsx"]) {
        try {
          statSync(join(WEB_ROOT, "hooks", base + ext));
          stack.push(base + ext);
          break;
        } catch {
          /* try next */
        }
      }
    }
  }
  return seen;
}

describe("every session-replica feeder is in the useSyncCore profile (derived)", () => {
  test("each hook that subscribes to a replica channel is reachable from useSyncCore", () => {
    const closure = hookClosure("useSyncCore.ts");
    const offenders: string[] = [];
    for (const name of readdirSync(join(WEB_ROOT, "hooks"))) {
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      const channels = usesChannel(read(join(WEB_ROOT, "hooks", name)));
      if (channels.length === 0) continue;
      if (!closure.has(name)) offenders.push(`hooks/${name} feeds ${channels.join(", ")} but useSyncCore does not mount it`);
    }
    expect(offenders).toEqual([]);
    // Sanity: the closure really covers the named channels (a typo in the
    // list above would otherwise pass vacuously).
    const covered = new Set<string>();
    for (const rel of closure) {
      try {
        for (const ch of usesChannel(read(join(WEB_ROOT, "hooks", rel)))) covered.add(ch);
      } catch {
        /* skipped */
      }
    }
    expect([...SESSION_REPLICA_CHANNELS].filter((ch) => !covered.has(ch))).toEqual([]);
  });

  test("no mobile file subscribes to a replica channel directly", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "components", "hooks", "lib"]) {
      for (const file of walkSources(join(MOBILE_ROOT, dir))) {
        const channels = usesChannel(read(file), SESSION_REPLICA_SUBSCRIPTIONS);
        if (channels.length) offenders.push(`${file.slice(MOBILE_ROOT.length + 1)}: ${channels.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});

// The mobile bundle (Hermes) cannot parse `import.meta`: Metro's transform
// throws on any MetaProperty for a native platform, and one failing module
// fails the WHOLE bundle — every OTA that carries useSyncCore would ship a
// dark inbox. Everything reachable from useSyncCore through relative imports
// under hooks/ and store/ is in that bundle unless a `.native.ts` twin
// shadows it, so none of it may read `import.meta` (use NODE_ENV, which both
// Vite and Metro replace — see inboxWarm.ts / inboxStore.ts).
describe("the useSyncCore import closure is Hermes-safe", () => {
  function closure(rootRel: string): Set<string> {
    const seen = new Set<string>();
    const stack = [rootRel];
    while (stack.length) {
      const rel = stack.pop()!;
      if (seen.has(rel)) continue;
      const abs = join(WEB_ROOT, rel);
      let src: string;
      try {
        src = read(abs);
      } catch {
        continue;
      }
      seen.add(rel);
      const dir = join(rel, "..");
      for (const m of src.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) {
        const base = join(dir, m[1]).replace(/\.tsx?$/, "");
        // A native twin shadows the web file on Metro; walk the twin instead.
        for (const ext of [".native.ts", ".native.tsx", ".ts", ".tsx", "/index.ts"]) {
          try {
            statSync(join(WEB_ROOT, base + ext));
            stack.push(base + ext);
            break;
          } catch {
            /* try next */
          }
        }
      }
    }
    return seen;
  }

  test("no module reachable from useSyncCore reads import.meta", () => {
    const offenders: string[] = [];
    const reachable = closure("hooks/useSyncCore.ts");
    // Sanity: the walk reaches the store and the warm loop (the module that
    // carried the last import.meta), so a pass is not vacuous.
    for (const must of ["hooks/inboxWarm.ts", "store/inboxStore.ts", "hooks/useInboxDigestCompare.ts"]) {
      expect(reachable.has(must), `closure misses ${must}`).toBe(true);
    }
    for (const rel of reachable) {
      if (rel.endsWith(".native.ts") || rel.endsWith(".native.tsx")) continue;
      // A twin shadows this file on Metro; the web copy is never bundled.
      try {
        statSync(join(WEB_ROOT, rel.replace(/\.tsx?$/, ".native.ts")));
        continue;
      } catch {
        /* no twin */
      }
      for (const { line, n } of codeLinesOf(read(join(WEB_ROOT, rel)))) {
        if (/\bimport\.meta\b/.test(line)) offenders.push(`${rel}:${n}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});
