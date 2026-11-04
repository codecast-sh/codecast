// A tapped push reads its conversation's new rows over HTTPS even when the
// phone holds none of them in memory yet (a cold launch, or a conversation not
// opened since launch), and a tap that lands before sign-in runs once the
// token arrives.
// Run: bun test lib/foregroundResume.test.ts
import { beforeAll, beforeEach, expect, mock, test } from "bun:test";

(globalThis as any).__DEV__ = false;
const CONV = "jx78ys86034d537jbzys8ygp498gxy46";

type Row = { timestamp: number };
const state = {
  messages: {} as Record<string, Row[]>,
  clientStateInitialized: true,
};
const disk: Record<string, Row[]> = {};
const reads: Array<{ convId: string; after: number }> = [];

mock.module("react-native", () => ({
  AppState: { addEventListener: () => ({ remove() {} }) },
  Platform: { OS: "ios" },
}));
mock.module("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
  },
}));
mock.module("@/lib/convex", () => ({ convex: {}, CONVEX_URL: "https://example.test" }));
mock.module("@/lib/socketStats", () => ({ socketStats: { lastConnectAt: 0 } }));
mock.module("@/modules/codecast-push-prefetch", () => ({ pushPrefetchNative: null }));
mock.module("@codecast/web/hooks/inboxWarm", () => ({
  readForward: async (_http: unknown, convId: string, after: number) => {
    reads.push({ convId, after });
    return 1;
  },
}));
mock.module("@codecast/web/store/inboxStore", () => ({
  isConvexId: (id: string) => /^[a-z0-9]{32}$/.test(id),
  ensureHydrated: async (convId: string) => {
    if (!state.messages[convId]?.length && disk[convId]) state.messages[convId] = disk[convId];
    return true;
  },
  useInboxStore: {
    getState: () => state,
    subscribe: () => () => {},
  },
}));

let mod: typeof import("./foregroundResume");

beforeAll(async () => {
  mod = await import("./foregroundResume");
});

beforeEach(() => {
  state.messages = {};
  for (const k of Object.keys(disk)) delete disk[k];
  reads.length = 0;
  mod.setCatchUpToken(null);
});

test("a push about a conversation held only on disk reads forward from the saved newest row", async () => {
  disk[CONV] = [{ timestamp: 100 }, { timestamp: 200 }];
  mod.setCatchUpToken("token");
  await mod.catchUpConversation(CONV);
  expect(reads).toEqual([{ convId: CONV, after: 200 }]);
});

test("a push tapped before sign-in reads its rows once the token arrives", async () => {
  disk[CONV] = [{ timestamp: 300 }];
  await mod.catchUpConversation(CONV);
  expect(reads).toEqual([]);
  mod.setCatchUpToken("token");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  expect(reads).toEqual([{ convId: CONV, after: 300 }]);
});

test("a conversation this phone never loaded is left to the screen's cold open", async () => {
  mod.setCatchUpToken("token");
  await mod.catchUpConversation(CONV);
  expect(reads).toEqual([]);
});
