import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import {
  bindCapability,
  unbindCapability,
  grantConsent,
  listConsents,
  sweepCapabilityEvents,
  EVENT_RETENTION_MS,
} from "./capabilities";
import { ingestObservation } from "./capabilities";

const TOKEN = "cast_consent_token";
const OWNER = "u_owner";

async function tables(extra: Record<string, any[]> = {}) {
  return {
    users: [{ _id: OWNER, name: "o" }],
    api_tokens: [{ _id: "t1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    capability_consents: [],
    capability_events: [],
    capability_observation: [],
    ...extra,
  } as Record<string, any[]>;
}

const ctx = (t: Record<string, any[]>) =>
  ({ db: makeFakeDb(t), scheduler: { runAfter: async () => null } }) as any;

describe("grantConsent", () => {
  test("stores the yes and writes the audit event", async () => {
    const t = await tables();
    const res = await (grantConsent as any)._handler(ctx(t), {
      api_token: TOKEN,
      device_id: "dev_a",
      capability_slug: "mkt/official/simplifier",
      manifest_hash: "aaaa",
    });
    expect(res.status).toBe("consented");
    expect(t.capability_consents).toHaveLength(1);
    expect(t.capability_events).toHaveLength(1);
    expect(t.capability_events[0].kind).toBe("consent");
  });

  test("saying yes twice is one fact, not two rows", async () => {
    const t = await tables();
    const args = {
      api_token: TOKEN,
      device_id: "dev_a",
      capability_slug: "mkt/official/simplifier",
      manifest_hash: "aaaa",
    };
    await (grantConsent as any)._handler(ctx(t), args);
    const second = await (grantConsent as any)._handler(ctx(t), args);
    expect(second.status).toBe("already_consented");
    expect(t.capability_consents).toHaveLength(1);
    expect(t.capability_events).toHaveLength(1);
  });

  test("a new hash for the same slug is a NEW consent — approval names bytes", async () => {
    const t = await tables();
    const base = { api_token: TOKEN, device_id: "dev_a", capability_slug: "mkt/official/x" };
    await (grantConsent as any)._handler(ctx(t), { ...base, manifest_hash: "aaaa" });
    await (grantConsent as any)._handler(ctx(t), { ...base, manifest_hash: "bbbb" });
    expect(t.capability_consents).toHaveLength(2);
  });

  test("consent is per device — one machine's yes is not another's", async () => {
    const t = await tables();
    await (grantConsent as any)._handler(ctx(t), {
      api_token: TOKEN, device_id: "dev_a", capability_slug: "mkt/official/x", manifest_hash: "aaaa",
    });
    const other = await (listConsents as any)._handler(ctx(t), {
      api_token: TOKEN, device_id: "dev_b",
    });
    expect(other).toHaveLength(0);
  });
});

describe("re-consent fires on the artifact hash, not the version", () => {
  const observation = (sha: string) =>
    JSON.stringify({
      kind: "plugin",
      name: "simplifier@official",
      manifest: { components: { plugin: ["simplifier"] }, envKeys: [], meta: undefined, gitCommitSha: sha },
    });

  test("a moved sha behind an unchanged listing fires a consent event within one ingest", async () => {
    const t = await tables();
    const c = ctx(t);
    const first = await (ingestObservation as any)._handler(c, {
      user_id: OWNER, device_id: "dev_a", client: "claude", raw_json: observation("sha-one"),
    });
    // The human consents to what is on disk now.
    await (grantConsent as any)._handler(c, {
      api_token: TOKEN, device_id: "dev_a",
      capability_slug: "mkt/official/simplifier", manifest_hash: first.manifest_hash,
    });
    const eventsBefore = t.capability_events.length;

    // The ref moves: same name, new commit — the manifest hash moves with it.
    await (ingestObservation as any)._handler(c, {
      user_id: OWNER, device_id: "dev_a", client: "claude", raw_json: observation("sha-two"),
    });
    const consentEvents = t.capability_events.slice(eventsBefore).filter((e: any) => e.kind === "consent");
    expect(consentEvents).toHaveLength(1);
    expect(consentEvents[0].capability_slug).toBe("mkt/official/simplifier");
  });

  test("an unconsented capability changing fires nothing — there is no prior yes to drift from", async () => {
    const t = await tables();
    const c = ctx(t);
    await (ingestObservation as any)._handler(c, {
      user_id: OWNER, device_id: "dev_a", client: "claude", raw_json: observation("sha-one"),
    });
    await (ingestObservation as any)._handler(c, {
      user_id: OWNER, device_id: "dev_a", client: "claude", raw_json: observation("sha-two"),
    });
    expect(t.capability_events.filter((e: any) => e.kind === "consent")).toHaveLength(0);
  });
});

describe("sweepCapabilityEvents", () => {
  test("drops rows past 90 days in bounded batches, keeps the rest", async () => {
    const now = Date.now();
    const t = await tables({
      capability_events: [
        { _id: "e_old", user_id: OWNER, kind: "consent", actor_user_id: OWNER, created_at: now - EVENT_RETENTION_MS - 1000 },
        { _id: "e_new", user_id: OWNER, kind: "apply", actor_user_id: OWNER, created_at: now - 1000 },
      ],
    });
    const res = await (sweepCapabilityEvents as any)._handler(ctx(t), {});
    expect(res.deleted).toBe(1);
    expect(t.capability_events.map((e: any) => e._id)).toEqual(["e_new"]);
  });
});

// ------------------------------------------------------------- the bind upsert

describe("bindCapability", () => {
  const args = (over: Record<string, unknown> = {}) => ({
    api_token: TOKEN,
    capability_slug: "mkt/official/simplifier",
    scope_kind: "user",
    scope_key: "",
    enabled: true,
    ...over,
  });

  test("bind then rebind is one row whose toggle stays put", async () => {
    const t = await tables({ capability_bindings: [] });
    const c = ctx(t);
    const first = await (bindCapability as any)._handler(c, args());
    expect(first.status).toBe("created");
    const second = await (bindCapability as any)._handler(c, args({ enabled: false }));
    expect(second.status).toBe("updated");
    expect(t.capability_bindings).toHaveLength(1);
    expect(t.capability_bindings[0].enabled).toBe(false);
  });

  test("pre-existing duplicates are folded into one on the next write", async () => {
    const t = await tables({
      capability_bindings: [
        { _id: "dup1", user_id: OWNER, capability_slug: "mkt/official/simplifier", scope_kind: "user", scope_key: "", enabled: true, updated_at: 1 },
        { _id: "dup2", user_id: OWNER, capability_slug: "mkt/official/simplifier", scope_kind: "user", scope_key: "", enabled: false, updated_at: 2 },
      ],
    });
    await (bindCapability as any)._handler(ctx(t), args({ enabled: true }));
    expect(t.capability_bindings).toHaveLength(1);
    expect(t.capability_bindings[0].enabled).toBe(true);
  });

  test("disable writes a row — never a delete that re-inherits the broader grant", async () => {
    const t = await tables({ capability_bindings: [] });
    await (bindCapability as any)._handler(ctx(t), args({ enabled: false }));
    expect(t.capability_bindings).toHaveLength(1);
    expect(t.capability_bindings[0].enabled).toBe(false);
  });

  test("a team binding with a local: scope key is refused", async () => {
    const t = await tables({
      capability_bindings: [],
      teams: [{ _id: "team_1", name: "t" }],
      team_memberships: [{ _id: "tm1", team_id: "team_1", user_id: OWNER, role: "admin" }],
    });
    const res = await (bindCapability as any)._handler(
      ctx(t),
      args({ scope_kind: "team", team_id: "team_1", scope_key: "local:u_owner:/Users/x/api" }),
    );
    expect(res.status).toBe("rejected");
    expect(res.reason).toBe("local_key_never_team");
    expect(t.capability_bindings).toHaveLength(0);
  });

  test("an unknown scope kind is refused before any write", async () => {
    const t = await tables({ capability_bindings: [] });
    const res = await (bindCapability as any)._handler(ctx(t), args({ scope_kind: "global" }));
    expect(res.status).toBe("rejected");
    expect(t.capability_bindings).toHaveLength(0);
  });

  test("unbind deletes and audits; enabled:false and unbind are different verbs", async () => {
    const t = await tables({ capability_bindings: [] });
    const c = ctx(t);
    await (bindCapability as any)._handler(c, args());
    const res = await (unbindCapability as any)._handler(c, {
      api_token: TOKEN,
      capability_slug: "mkt/official/simplifier",
      scope_kind: "user",
      scope_key: "",
    });
    expect(res.removed).toBe(1);
    expect(t.capability_bindings).toHaveLength(0);
    expect(t.capability_events.some((e: any) => e.kind === "unbind")).toBe(true);
  });
});
