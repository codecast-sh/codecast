// The kit: access by workspace key, version dedupe by folder hash, the shared
// bindings reader, and the web's publish request.

import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { hashToken } from "./apiTokens";
import {
  deriveKitSurfaces,
  getKitVersion,
  adoptKitItem,
  grantConsent,
  webKitConflicts,
  listKitItems,
  publishKitItem,
  removeItem,
  removeKitItemForToken,
  reportKitApplied,
  requestTeamKitPublish,
  webListTeamKitItems,
  webPendingConsents,
  webVersions,
} from "./teamKit";
import { bindCapability, listAdoptions, listBindingsForToken, listConsents, webListBindings } from "./capabilityBindings";

const ALICE = "u_alice"; // team A admin
const AMY = "u_amy"; // team A member
const BOB = "u_bob"; // team B member
const TEAM_A = "team_a";
const TEAM_B = "team_b";
const TOKENS: Record<string, string> = { [ALICE]: "tok_alice", [AMY]: "tok_amy", [BOB]: "tok_bob" };

async function seed() {
  return {
    users: [{ _id: ALICE }, { _id: AMY }, { _id: BOB }],
    teams: [{ _id: TEAM_A }, { _id: TEAM_B }],
    team_memberships: [
      { _id: "m1", user_id: ALICE, team_id: TEAM_A, role: "admin" },
      { _id: "m2", user_id: AMY, team_id: TEAM_A, role: "member" },
      { _id: "m3", user_id: BOB, team_id: TEAM_B, role: "member" },
    ],
    api_tokens: await Promise.all(
      Object.entries(TOKENS).map(async ([user, tok], i) => ({ _id: `t${i}`, user_id: user, token_hash: await hashToken(tok) })),
    ),
    devices: [
      { _id: "d1", user_id: ALICE, device_id: "alice-mac" },
      { _id: "d2", user_id: BOB, device_id: "bob-mac" },
    ],
    team_kit_items: [],
    team_kit_versions: [],
    team_kit_applied: [],
    capability_bindings: [],
    capability_consents: [],
    capability_events: [],
    daemon_commands: [],
  } as Record<string, any[]>;
}

function harness(tables: Record<string, any[]>) {
  const deletedBlobs: string[] = [];
  const db: any = makeFakeDb(tables, {
    indexes: schemaIndexes(schema as any),
    strictPatch: true,
    mintId: (table, n) => `${table}_${n}`,
  });
  db.system = { get: async (id: string) => (id.startsWith("blob") ? { _id: id, size: 1000 } : null) };
  const ctxFor = (userId: string | null) =>
    ({
      db,
      auth: { getUserIdentity: async () => (userId ? { subject: `${userId}|session` } : null) },
      storage: {
        generateUploadUrl: async () => "https://upload",
        getUrl: async (id: string) => `https://dl/${id}`,
        delete: async (id: string) => void deletedBlobs.push(id),
      },
      scheduler: { runAfter: async () => null },
    }) as any;
  return { ctxFor, deletedBlobs, tables };
}

const run = (fn: any, c: any, args: any) => fn._handler(c, args);

const skill = (over: Record<string, any> = {}) => ({
  kind: "skill",
  name: "deploy-checklist",
  description: "How we deploy",
  folder_hash: "a".repeat(64),
  storage_id: "blob1",
  files: [{ path: "SKILL.md", size: 120, executable: false }],
  main_body: "---\nname: deploy-checklist\ndescription: How we deploy\n---\nRun the checks.",
  ...over,
});

describe("access by workspace", () => {
  test("a team A member reads team A's item; a team B member does not", async () => {
    const { ctxFor } = harness(await seed());
    const pub = await run(publishKitItem, ctxFor(null), { api_token: TOKENS[ALICE], team_id: TEAM_A, ...skill() });
    expect(pub.status).toBe("created");
    expect(pub.slug).toBe(`authored/${TEAM_A}/skill/deploy-checklist`);

    const amyRead = await run(getKitVersion, ctxFor(null), { api_token: TOKENS[AMY], slug: pub.slug });
    expect(amyRead?.folder_hash).toBe("a".repeat(64));
    expect(amyRead?.download_url).toBe("https://dl/blob1");
    expect(amyRead?.surfaces).toEqual(["prose"]);
    expect((await run(webListTeamKitItems, ctxFor(AMY), {})).items.map((i: any) => i.slug)).toEqual([pub.slug]);
    expect((await run(webVersions, ctxFor(AMY), { item_id: pub.item_id }))).toHaveLength(1);

    expect(await run(getKitVersion, ctxFor(null), { api_token: TOKENS[BOB], slug: pub.slug })).toBeNull();
    expect((await run(webListTeamKitItems, ctxFor(BOB), {})).items).toEqual([]);
    expect((await run(listKitItems, ctxFor(null), { api_token: TOKENS[BOB] })).items).toEqual([]);
    expect(await run(webVersions, ctxFor(BOB), { item_id: pub.item_id })).toEqual([]);
  });

  test("a non-member cannot publish into a team", async () => {
    const { ctxFor, tables } = harness(await seed());
    await expect(run(publishKitItem, ctxFor(null), { api_token: TOKENS[BOB], team_id: TEAM_A, ...skill() })).rejects.toThrow();
    expect(tables.team_kit_items).toHaveLength(0);
  });

  test("no team publishes to the personal kit, readable by its owner only", async () => {
    const { ctxFor, tables } = harness(await seed());
    const pub = await run(publishKitItem, ctxFor(null), { api_token: TOKENS[AMY], ...skill() });
    expect(pub.slug).toBe(`authored/${AMY}/skill/deploy-checklist`);
    expect(tables.team_kit_items[0].workspace).toBe(`user:${AMY}`);
    expect(tables.team_kit_items[0].team_id).toBeUndefined();
    expect(await run(getKitVersion, ctxFor(null), { api_token: TOKENS[AMY], slug: pub.slug })).not.toBeNull();
    expect(await run(getKitVersion, ctxFor(null), { api_token: TOKENS[ALICE], slug: pub.slug })).toBeNull();
  });
});

describe("versions", () => {
  test("the same hash is one version; the duplicate upload is deleted", async () => {
    const { ctxFor, tables, deletedBlobs } = harness(await seed());
    const first = await run(publishKitItem, ctxFor(null), { api_token: TOKENS[ALICE], team_id: TEAM_A, ...skill() });
    const again = await run(publishKitItem, ctxFor(null), {
      api_token: TOKENS[ALICE], team_id: TEAM_A, ...skill({ storage_id: "blob2" }),
    });
    expect(again.status).toBe("unchanged");
    expect(again.version).toBe(1);
    expect(tables.team_kit_versions).toHaveLength(1);
    expect(deletedBlobs).toEqual(["blob2"]);

    const next = await run(publishKitItem, ctxFor(null), {
      api_token: TOKENS[AMY], team_id: TEAM_A, ...skill({ folder_hash: "b".repeat(64), storage_id: "blob3" }),
    });
    expect(next).toMatchObject({ status: "created", version: 2, item_id: first.item_id });
    expect(tables.team_kit_items[0]).toMatchObject({ current_version: 2, current_hash: "b".repeat(64) });
    // A new version re-plans every member's machines, not just the publisher's.
    expect(tables.users.find((u: any) => u._id === ALICE).capability_revision).toBe(1);
    expect(tables.users.find((u: any) => u._id === AMY).capability_revision).toBe(1);
    expect(tables.users.find((u: any) => u._id === BOB).capability_revision).toBeUndefined();

    // Republishing version 1's bytes makes it current again, without a third row.
    const back = await run(publishKitItem, ctxFor(null), { api_token: TOKENS[ALICE], team_id: TEAM_A, ...skill({ storage_id: "blob4" }) });
    expect(back).toMatchObject({ status: "unchanged", version: 1 });
    expect(tables.team_kit_items[0].current_version).toBe(1);
    expect(tables.team_kit_versions).toHaveLength(2);
  });

  test("a body with control characters is refused, not stored cleaned", async () => {
    const { ctxFor, tables } = harness(await seed());
    const res = await run(publishKitItem, ctxFor(null), {
      api_token: TOKENS[ALICE], team_id: TEAM_A, ...skill({ main_body: "hi\u0007there" }),
    });
    expect(res).toEqual({ status: "rejected", reason: "main_body_rejected" });
    expect(tables.team_kit_items).toHaveLength(0);
  });

  test("a path that escapes the item is refused", async () => {
    const { ctxFor } = harness(await seed());
    const res = await run(publishKitItem, ctxFor(null), {
      api_token: TOKENS[ALICE], team_id: TEAM_A, ...skill({ files: [{ path: "../x.md", size: 1, executable: false }] }),
    });
    expect(res).toEqual({ status: "rejected", reason: "invalid_files" });
  });
});

describe("deriveKitSurfaces", () => {
  test("markdown alone is prose", () => {
    expect(deriveKitSurfaces([{ path: "SKILL.md", size: 1, executable: false }], "plain")).toEqual(["prose"]);
  });
  test("scripts, executables and frontmatter grants raise it", () => {
    const files = [
      { path: "SKILL.md", size: 1, executable: false },
      { path: "scripts/run.py", size: 1, executable: false },
      { path: "tool", size: 1, executable: true },
    ];
    const body = "---\nname: x\nallowed-tools:\n  - Bash\nhooks:\n  PreToolUse: []\n---\n";
    expect(deriveKitSurfaces(files, body)).toEqual(["prose", "declares_allowed_tools", "ships_scripts", "ships_bin", "declares_hooks"]);
  });
});

describe("bindings reader", () => {
  test("a team binding reaches every member, with its team_id; a teammate's own binding does not", async () => {
    const { ctxFor } = harness(await seed());
    const slug = `authored/${TEAM_A}/skill/deploy-checklist`;
    const team = await run(bindCapability, ctxFor(null), {
      api_token: TOKENS[ALICE], capability_slug: slug, scope_kind: "team", scope_key: "", enabled: true, team_id: TEAM_A,
    });
    expect(team.status).toBe("created");
    // Alice's own user-scope binding, routed to the team, is hers alone.
    await run(bindCapability, ctxFor(null), {
      api_token: TOKENS[ALICE], capability_slug: "authored/x/skill/y", scope_kind: "user", scope_key: "", enabled: true, team_id: TEAM_A,
    });

    const amyCli = await run(listBindingsForToken, ctxFor(null), { api_token: TOKENS[AMY] });
    expect(amyCli).toHaveLength(1);
    expect(amyCli[0]).toMatchObject({ capability_slug: slug, scope_kind: "team", team_id: TEAM_A, user_id: ALICE });
    const amyWeb = await run(webListBindings, ctxFor(AMY), {});
    expect(amyWeb.items.map((r: any) => r.capability_slug)).toEqual([slug]);

    expect(await run(listBindingsForToken, ctxFor(null), { api_token: TOKENS[BOB] })).toEqual([]);
    expect(await run(listBindingsForToken, ctxFor(null), { api_token: TOKENS[ALICE] })).toHaveLength(2);
  });

  test("a team cannot turn on another workspace's item", async () => {
    const { ctxFor } = harness(await seed());
    const res = await run(bindCapability, ctxFor(null), {
      api_token: TOKENS[ALICE], capability_slug: `authored/${ALICE}/skill/mine`, scope_kind: "team", scope_key: "", enabled: true, team_id: TEAM_A,
    });
    expect(res).toEqual({ status: "rejected", reason: "kit_item_not_in_team" });
  });
});

describe("web publish request", () => {
  test("inserts a cap_publish command targeted at the viewer's device", async () => {
    const { ctxFor, tables } = harness(await seed());
    const res = await run(requestTeamKitPublish, ctxFor(ALICE), {
      device_id: "alice-mac", kind: "skill", name: "deploy-checklist", team_id: TEAM_A, note: "first cut", client_key: "ck1",
    });
    expect(res.slug).toBe(`authored/${TEAM_A}/skill/deploy-checklist`);
    expect(res.client_key).toBe("ck1");
    expect(tables.daemon_commands).toHaveLength(1);
    const cmd = tables.daemon_commands[0];
    expect(cmd).toMatchObject({ user_id: ALICE, command: "cap_publish", target_device_id: "alice-mac" });
    expect(JSON.parse(cmd.args)).toEqual({ kind: "skill", name: "deploy-checklist", team_id: TEAM_A, note: "first cut" });
  });

  test("refuses another person's device and a team the viewer is not in", async () => {
    const { ctxFor, tables } = harness(await seed());
    await expect(run(requestTeamKitPublish, ctxFor(ALICE), { device_id: "bob-mac", kind: "skill", name: "x" })).rejects.toThrow();
    await expect(
      run(requestTeamKitPublish, ctxFor(BOB), { device_id: "bob-mac", kind: "skill", name: "x", team_id: TEAM_A }),
    ).rejects.toThrow();
    expect(tables.daemon_commands).toHaveLength(0);
  });
});

describe("removal and consent", () => {
  test("removing an item disables its bindings and hides it from installers", async () => {
    const { ctxFor, tables } = harness(await seed());
    const pub = await run(publishKitItem, ctxFor(null), { api_token: TOKENS[AMY], team_id: TEAM_A, ...skill() });
    await run(bindCapability, ctxFor(null), {
      api_token: TOKENS[ALICE], capability_slug: pub.slug, scope_kind: "team", scope_key: "", enabled: true, team_id: TEAM_A,
    });
    await run(bindCapability, ctxFor(null), {
      api_token: TOKENS[AMY], capability_slug: pub.slug, scope_kind: "user", scope_key: "", enabled: true,
    });
    // Bob is not in the team; Alice is an admin but not the author, which is enough.
    await expect(run(removeItem, ctxFor(BOB), { item_id: pub.item_id })).rejects.toThrow();
    const res = await run(removeItem, ctxFor(ALICE), { item_id: pub.item_id });
    expect(res).toEqual({ status: "removed", disabled: 2 });
    expect(tables.capability_bindings.every((b: any) => b.enabled === false)).toBe(true);
    expect(await run(getKitVersion, ctxFor(null), { api_token: TOKENS[AMY], slug: pub.slug })).toBeNull();
    const listed = (await run(webListTeamKitItems, ctxFor(AMY), {})).items;
    expect(listed[0].removed_at).toBeNumber();

    // Sharing again restores it, current at the republished bytes.
    const again = await run(publishKitItem, ctxFor(null), { api_token: TOKENS[AMY], team_id: TEAM_A, ...skill({ storage_id: "blob9" }) });
    expect(again).toMatchObject({ status: "unchanged", version: 1 });
    expect(tables.team_kit_items[0].removed_at).toBeUndefined();
    expect(await run(getKitVersion, ctxFor(null), { api_token: TOKENS[AMY], slug: pub.slug })).not.toBeNull();
    const fresh = await run(publishKitItem, ctxFor(null), {
      api_token: TOKENS[AMY], team_id: TEAM_A, ...skill({ folder_hash: "c".repeat(64), storage_id: "blob10" }),
    });
    expect(fresh).toMatchObject({ status: "created", version: 2 });
  });

  test("the CLI unpublishes by slug; a stranger gets not_found", async () => {
    const { ctxFor, tables } = harness(await seed());
    const pub = await run(publishKitItem, ctxFor(null), { api_token: TOKENS[AMY], ...skill() });
    expect(await run(removeKitItemForToken, ctxFor(null), { api_token: TOKENS[BOB], slug: pub.slug })).toEqual({ status: "not_found", disabled: 0 });
    expect(tables.team_kit_items[0].removed_at).toBeUndefined();
    const res = await run(removeKitItemForToken, ctxFor(null), { api_token: TOKENS[AMY], slug: pub.slug });
    expect(res.status).toBe("removed");
    expect(tables.team_kit_items[0].removed_at).toBeNumber();
  });

  test("pending consents come from the device's report and clear on Allow", async () => {
    const { ctxFor, tables } = harness(await seed());
    const slug = `authored/${TEAM_A}/skill/runner`;
    await run(reportKitApplied, ctxFor(null), {
      api_token: TOKENS[ALICE], device_id: "alice-mac",
      items: [{ slug, hash: "h1", status: "pending_consent" }, { slug: `authored/${TEAM_A}/skill/doc`, hash: "h2", status: "installed" }],
    });
    expect(await run(webPendingConsents, ctxFor(ALICE), {})).toEqual([{ device_id: "alice-mac", slug, hash: "h1" }]);
    expect(await run(webPendingConsents, ctxFor(BOB), {})).toEqual([]);

    await expect(run(grantConsent, ctxFor(BOB), { device_id: "alice-mac", slug, hash: "h1" })).rejects.toThrow();
    expect((await run(grantConsent, ctxFor(ALICE), { device_id: "alice-mac", slug, hash: "h1" })).status).toBe("consented");
    expect(tables.capability_consents).toHaveLength(1);
    expect(await run(webPendingConsents, ctxFor(ALICE), {})).toEqual([]);

    // A slug the device stops reporting turns removed, never vanishes.
    const again = await run(reportKitApplied, ctxFor(null), { api_token: TOKENS[ALICE], device_id: "alice-mac", items: [] });
    expect(again.written).toBe(2);
    expect(tables.team_kit_applied.map((r: any) => r.status)).toEqual(["removed", "removed"]);
  });

  test("a conflict is listed until adopted for that hash; adoption is not consent", async () => {
    const { ctxFor, tables } = harness(await seed());
    const slug = `authored/${TEAM_A}/skill/kit-web-e2e`;
    const detail = "~/.claude/skills/kit-web-e2e exists and was not written by codecast";
    await run(reportKitApplied, ctxFor(null), {
      api_token: TOKENS[ALICE], device_id: "alice-mac", items: [{ slug, hash: "h1", status: "conflict", detail }],
    });
    expect(await run(webKitConflicts, ctxFor(ALICE), {})).toEqual([{ device_id: "alice-mac", slug, hash: "h1", detail }]);
    expect(await run(webKitConflicts, ctxFor(BOB), {})).toEqual([]);
    // A consent for the same hash does not resolve a conflict.
    await run(grantConsent, ctxFor(ALICE), { device_id: "alice-mac", slug, hash: "h1" });
    expect(await run(webKitConflicts, ctxFor(ALICE), {})).toHaveLength(1);

    await expect(run(adoptKitItem, ctxFor(BOB), { device_id: "alice-mac", slug, hash: "h1" })).rejects.toThrow();
    const res = await run(adoptKitItem, ctxFor(ALICE), { device_id: "alice-mac", slug, hash: "h1" });
    expect(res.status).toBe("adopted");
    expect((await run(adoptKitItem, ctxFor(ALICE), { device_id: "alice-mac", slug, hash: "h1" })).status).toBe("already_adopted");
    expect(await run(webKitConflicts, ctxFor(ALICE), {})).toEqual([]);
    expect(tables.users.find((u: any) => u._id === ALICE).capability_revision).toBe(2);
    expect(tables.capability_events.map((e: any) => e.kind)).toEqual(["consent", "adopt"]);

    // The daemon reads them apart: an adoption never counts as consent.
    const adoptions = await run(listAdoptions, ctxFor(null), { api_token: TOKENS[ALICE], device_id: "alice-mac" });
    expect(adoptions).toEqual([{ slug, hash: "h1", adopted_at: expect.any(Number) }]);
    const consents = await run(listConsents, ctxFor(null), { api_token: TOKENS[ALICE], device_id: "alice-mac" });
    expect(consents.map((c: any) => c.manifest_hash)).toEqual(["h1"]);
    expect(tables.capability_consents).toHaveLength(2);

    // A new version's conflict is a new question.
    await run(reportKitApplied, ctxFor(null), {
      api_token: TOKENS[ALICE], device_id: "alice-mac", items: [{ slug, hash: "h2", status: "conflict", detail }],
    });
    expect((await run(webKitConflicts, ctxFor(ALICE), {})).map((c: any) => c.hash)).toEqual(["h2"]);
  });
});
