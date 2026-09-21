import { describe, expect, test } from "bun:test";
import { dispatch, isDispatchAction } from "./dispatch";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeDb } from "./testDb";

const USER = "users_member";
const auth = { getUserIdentity: async () => ({ subject: `${USER}|session` }) };
const run = (db: any, patches: any) => (dispatch as any)._handler({ db, auth }, {
  action: "patchConversation", args: [], patches,
});

describe("dispatch table authority", () => {
  for (const [policy, fields] of Object.entries({ conversations: { title: "forged" }, inbox_buckets: { name: "forged" }, session_decisions: { status: "answered" }, comments: { content: "forged" } })) {
    for (const table of ["team_memberships", "api_tokens", "daemon_commands"]) {
      test(`${policy} refuses a ${table} ID before reading or writing it`, async () => {
        const id = `${table}_1`;
        const db = makeFakeDb({ [table]: [{ _id: id, user_id: USER, role: "member" }] });
        const normalizations: string[][] = [];
        const normalizeId = db.normalizeId;
        db.normalizeId = (table: string, key: string) => { normalizations.push([table, key]); return normalizeId(table, key); };
        const reads: string[] = [];
        const get = db.get;
        db.get = async (key: string) => { reads.push(key); return get(key); };
        await run(db, { [policy]: { [id]: fields } });
        expect(normalizations).toEqual([[policy, id]]);
        expect(reads).toEqual([]);
        expect(db._patched).toEqual([]);
        expect(db._deleted).toEqual([]);
        expect(db._inserted).toEqual([]);
      });
    }
  }

  test("ordinary conversation updates still pass", async () => {
    const db = makeFakeDb({ conversations: [{ _id: "conversations_1", user_id: USER }] });
    await run(db, { conversations: { conversations_1: { title: "Renamed" } } });
    expect(db._tables.conversations[0].title).toBe("Renamed");
  });

  test("a missing or malformed ID causes no write", async () => {
    const db = makeFakeDb({ conversations: [] });
    await run(db, { conversations: { local_stub: { title: "Renamed" } } });
    expect(db._patched).toEqual([]);
  });
});

describe("fake database ID identity", () => {
  test("normalization retains table identity after deletion", async () => {
    const db = makeFakeDb({ conversations: [{ _id: "arbitrary_fixture_id" }] });
    await db.delete("arbitrary_fixture_id");
    expect(db.normalizeId("conversations", "arbitrary_fixture_id")).toBe("arbitrary_fixture_id");
    expect(db.normalizeId("comments", "arbitrary_fixture_id")).toBeNull();
    expect(await db.get("arbitrary_fixture_id")).toBeNull();
    const created = await db.insert("comments", {});
    await db.delete(created);
    expect(db.normalizeId("comments", created)).toBe(created);
    expect(db.normalizeId("conversations", created)).toBeNull();
  });
});

describe("dispatch editable fields", () => {
  test("unknown actions cannot apply even an ordinary patch", async () => {
    for (const action of ["unknown", "constructor", "toString", "__proto__"]) {
      const db = makeFakeDb({ conversations: [{ _id: "conv", user_id: USER }] });
      await expect((dispatch as any)._handler({ db, auth }, { action, args: [], patches: { conversations: { conv: { title: "Changed" } } } })).rejects.toThrow("Unknown dispatch action");
      expect(db._patched).toEqual([]);
    }
  });
  test("server authority, workflow pointers, command payloads and unknown fields are not editable", async () => {
    const db = makeFakeDb({
      conversations: [{ _id: "conv", user_id: USER }],
      inbox_buckets: [{ _id: "bucket", user_id: USER }],
      session_decisions: [{ _id: "decision", user_id: USER, status: "pending" }],
      comments: [{ _id: "comment", user_id: USER }],
    });
    await run(db, {
      conversations: { conv: { owner_device_id: "foreign", author_user_id: "foreign", fork_daemon_args: "forged", profile_pinned_at: 1, cloud_placement_token: "forged", unknown: true } },
      inbox_buckets: { bucket: { user_id: "foreign", workspace: "team:foreign", unknown: true } },
      session_decisions: { decision: { workflow_run_id: "foreign", gate_node_id: "forged", silent: true, applied_at: 1, resolved_by: "foreign", unknown: true } },
      comments: { comment: { conversation_id: "foreign", resolved_by: "foreign", unknown: true } },
    });
    expect(db._patched).toEqual([]);
    expect(db._inserted).toEqual([]);
  });
  test("model, character, project and thread state patches survive outbox replay", async () => {
    const db = makeFakeDb({ conversations: [{ _id: "conv", user_id: USER }] });
    const fields = { title: "Renamed", title_is_custom: true, project_path: "/project", git_root: "/project", model: "model", effort: "high", agent_definition: "reviewer", thread_state: "Working", thread_state_at: 1, thread_state_msg_count: 2, thread_state_status: "working", character_name: "Name" };
    await run(db, { conversations: { conv: fields } });
    expect(db._tables.conversations[0]).toMatchObject(fields);
  });
  test("existing bucket and client preference edits retain their ordinary fields", async () => {
    const db = makeFakeDb({ inbox_buckets: [{ _id: "bucket", user_id: USER }], client_state: [{ _id: "prefs", user_id: USER, ui: { theme: "dark" } }] });
    await run(db, { inbox_buckets: { bucket: { name: "Work", color: "blue", sort_order: 2 } }, client_state: { singleton: { ui: { fontSize: 14 }, user_id: "foreign", unknown: true } } });
    expect(db._tables.inbox_buckets[0]).toMatchObject({ name: "Work", color: "blue", sort_order: 2 });
    expect(db._tables.client_state[0]).toMatchObject({ user_id: USER, ui: { theme: "dark", fontSize: 14 } });
    expect(db._tables.client_state[0].unknown).toBeUndefined();
  });
});


test("every current client action has an admitted dispatch contract", () => {
  const directory = join(import.meta.dir, "../../web/store");
  const actions = new Set<string>();
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".ts") || name.includes(".test.")) continue;
    const source = readFileSync(join(directory, name), "utf8");
    for (const match of source.matchAll(/^\s+(\w+): (?:action|asyncAction|receiptAsyncAction)\(/gm)) actions.add(match[1]);
  }
  expect(actions.size).toBeGreaterThan(100);
  expect([...actions].filter(name => !isDispatchAction(name))).toEqual([]);
});
