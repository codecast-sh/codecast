import { describe, expect, test } from "bun:test";
import { offerBrowserPane, markBrowserPaneOffered } from "./conversations";
import { makeFakeDb } from "./testDb";

// `cast browser pane <url>`. Three things must hold or the chip lies to the
// reader: the stored URL is one an iframe may load, an offer replaces the
// previous one rather than queueing behind it, and acting on the chip stamps
// it once so it stays handled everywhere.

const RUNNER = "users_runner" as any;
const STRANGER = "users_stranger" as any;
const CONV = "conversations_1";

function tablesWith(extra: Record<string, unknown> = {}) {
  return {
    users: [{ _id: RUNNER }, { _id: STRANGER }],
    conversations: [{
      _id: CONV,
      user_id: RUNNER,
      short_id: "abc1234",
      session_id: "s1",
      title: "Dev server",
      ...extra,
    }],
    managed_sessions: [],
    session_owners: [],
    team_memberships: [],
  } as Record<string, any[]>;
}

const ctxAs = (db: any, userId: string) => ({
  db,
  scheduler: { runAfter: async () => {} },
  auth: { getUserIdentity: async () => ({ subject: `${userId}|session` }) },
}) as any;

const offer = (tables: Record<string, any[]>) => (tables.conversations[0] as any).browser_pane_offer;

describe("offerBrowserPane", () => {
  test("a bare host and port becomes a loadable http URL and stamps when it was offered", async () => {
    const tables = tablesWith();
    const res = await (offerBrowserPane as any)._handler(ctxAs(makeFakeDb(tables), RUNNER), {
      session: "abc1234",
      url: "localhost:3000",
      title: "Dev server",
    });
    expect(res).toMatchObject({ ok: true, short_id: "abc1234", url: "http://localhost:3000/" });
    expect(offer(tables)).toMatchObject({ url: "http://localhost:3000/", title: "Dev server" });
    expect(typeof offer(tables).offered_at).toBe("number");
    expect(offer(tables).opened_at).toBeUndefined();
  });

  test("a scheme an iframe must never load is refused, and nothing is stored", async () => {
    const tables = tablesWith();
    await expect((offerBrowserPane as any)._handler(ctxAs(makeFakeDb(tables), RUNNER), {
      session: "abc1234",
      url: "javascript://alert(1)",
    })).rejects.toThrow("not a web address");
    expect(offer(tables)).toBeUndefined();
  });

  test("the newest offer replaces the last one, unopened", async () => {
    const tables = tablesWith({ browser_pane_offer: { url: "http://localhost:3000/", offered_at: 1, opened_at: 2 } });
    await (offerBrowserPane as any)._handler(ctxAs(makeFakeDb(tables), RUNNER), {
      session: "abc1234",
      url: "http://localhost:4000",
    });
    expect(offer(tables).url).toBe("http://localhost:4000/");
    expect(offer(tables).opened_at).toBeUndefined();
  });

  test("a session the caller neither runs nor owns is refused", async () => {
    const tables = tablesWith();
    await expect((offerBrowserPane as any)._handler(ctxAs(makeFakeDb(tables), STRANGER), {
      session: "abc1234",
      url: "localhost:3000",
    })).rejects.toThrow("No session found");
    expect(offer(tables)).toBeUndefined();
  });
});

describe("markBrowserPaneOffered", () => {
  test("acting on the chip stamps it once", async () => {
    const tables = tablesWith({ browser_pane_offer: { url: "http://localhost:3000/", offered_at: 1 } });
    const db = makeFakeDb(tables);
    const first = await (markBrowserPaneOffered as any)._handler(ctxAs(db, RUNNER), { conversation_id: CONV });
    expect(first).toEqual({ ok: true, changed: true });
    const stamped = offer(tables).opened_at;
    expect(typeof stamped).toBe("number");

    const again = await (markBrowserPaneOffered as any)._handler(ctxAs(db, RUNNER), { conversation_id: CONV });
    expect(again).toEqual({ ok: true, changed: false });
    expect(offer(tables).opened_at).toBe(stamped);
  });

  test("a conversation with no offer is a no-op, not an error", async () => {
    const tables = tablesWith();
    expect(await (markBrowserPaneOffered as any)._handler(ctxAs(makeFakeDb(tables), RUNNER), {
      conversation_id: CONV,
    })).toEqual({ ok: true, changed: false });
  });

  test("someone who cannot see the session cannot clear its chip", async () => {
    const tables = tablesWith({ browser_pane_offer: { url: "http://localhost:3000/", offered_at: 1 } });
    await expect((markBrowserPaneOffered as any)._handler(ctxAs(makeFakeDb(tables), STRANGER), {
      conversation_id: CONV,
    })).rejects.toThrow("Unauthorized");
    expect(offer(tables).opened_at).toBeUndefined();
  });
});
