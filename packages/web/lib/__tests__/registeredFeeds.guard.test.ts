import { describe, expect, test } from "bun:test";
import { checkRatchet, codeOnly } from "@codecast/shared/ratchet";
import { join } from "node:path";
import { REGISTERED_FEEDS } from "../../store/clientSyncRegistry";

// LOCAL-FIRST LEAKAGE RATCHET.
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
// widen the allowlist. The allowlist is for the feeder machinery itself, the
// count may only fall, and an entry whose file stopped subscribing fails here
// too: this guard carried a line for components/DashboardSyncEffects.tsx long
// after that file was deleted.

const ROOT = join(import.meta.dir, "..", "..");
const ALLOWLIST = join(import.meta.dir, "registeredFeeds.allowlist.txt");

/** `api.plans.webList`, `(api as any).plans.webList`, `api["plans"].webList`. */
const feedPattern = (feed: string) =>
  new RegExp(String.raw`\bapi\)?(?:\.|\[["'])` + feed.replace(".", String.raw`(?:["']\])?\.`) + String.raw`\b`);

/** How many files subscribe to a registered feed directly. May only fall. */
const PIN = 0;

const feeds = Object.keys(REGISTERED_FEEDS);
const patterns = feeds.map(feedPattern);

const result = checkRatchet({
  name: "direct subscription to a registered store feed",
  root: ROOT,
  dirs: ["app", "components"],
  ignoreDirs: ["__tests__"],
  exempt: (rel) => /\.test\.tsx?$/.test(rel),
  count: (src) =>
    codeOnly(src)
      .split("\n")
      // A type reference (`FunctionReturnType<typeof api.x.y>`) names the
      // query without subscribing to it.
      .filter((line) => !/\btypeof\s+api\b/.test(line))
      .reduce((hits, line) => hits + (patterns.some((re) => re.test(line)) ? 1 : 0), 0),
  allowlist: ALLOWLIST,
  pin: PIN,
  fix: "Read the store (useTrackedStore / useCollectionRows / useWorkspaceCollection) and mount the feeder hook in hooks/.",
  pruneCommand: "cd packages/web && RATCHET_WRITE=prune bun test lib/__tests__/registeredFeeds.guard.test.ts",
  minScanned: 400,
});

describe("registered feeds are subscribed only by feeder hooks", () => {
  test("the registry declares feeds at all", () => {
    // A registry read that returned nothing would make the scan vacuous.
    expect(feeds.length).toBeGreaterThan(0);
  });

  test("no component or page subscribes directly to a query registered as a store feed", () => {
    expect(result.problems).toEqual([]);
  }, 120_000);
});
