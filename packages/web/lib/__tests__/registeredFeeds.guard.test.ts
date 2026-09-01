import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { walkSources } from "./sourceWalk";
import { join } from "node:path";
import { REGISTERED_FEEDS } from "../../store/clientSyncRegistry";

// LOCAL-FIRST LEAKAGE GUARD.
//
// A store collection registers the Convex queries that feed it
// (clientSyncRegistry `feeds`). From then on, a component or page that
// subscribes to that query directly is a regression: it renders from a
// round-trip a surface the store could have painted synchronously, and it
// re-creates exactly the "loading state on a page whose data we already had"
// bug this rule exists to prevent. Feeders live in hooks/ (useSyncCollection
// or a bespoke useSync* hook); everything under app/ and components/ reads the
// store.
//
// If this fails on new code, the fix is to read the store (useTrackedStore /
// useWorkspaceCollection / a selector) and mount the feeder hook — not to
// widen the allowlist. The allowlist is for the feeder machinery itself.

const ROOT = join(import.meta.dir, "..", "..");
const DIRS = ["app", "components"];

const ALLOWED = new Map<string, string>([
  ["components/DashboardSyncEffects.tsx", "mounts the app-wide feeders"],
]);

const walk = (dir: string) => walkSources(dir);

describe("registered feeds are subscribed only by feeder hooks", () => {
  test("no component or page subscribes directly to a query registered as a store feed", () => {
    const feeds = Object.keys(REGISTERED_FEEDS);
    expect(feeds.length).toBeGreaterThan(0);
    // `api.plans.webList` / `(api as any).plans.webList` / `api["plans"].webList`
    const patterns = feeds.map((f) => ({
      feed: f,
      re: new RegExp(String.raw`\bapi\)?(?:\.|\[["'])` + f.replace(".", String.raw`(?:["']\])?\.`) + String.raw`\b`),
    }));
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = file.slice(ROOT.length + 1);
        if (ALLOWED.has(rel)) continue;
        const src = readFileSync(file, "utf8");
        src.split("\n").forEach((line, i) => {
          // A type reference (`FunctionReturnType<typeof api.x.y>`) and a
          // comment name the query without subscribing to it.
          const t = line.trim();
          if (t.startsWith("//") || t.startsWith("*") || /\btypeof\s+api\b/.test(line)) return;
          for (const { feed, re } of patterns) {
            if (re.test(line)) offenders.push(`${rel}:${i + 1} subscribes to ${feed} (feeds store.${REGISTERED_FEEDS[feed]})`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  }, 120_000); // IO-bound source walk; the box is often under heavy test load
});
