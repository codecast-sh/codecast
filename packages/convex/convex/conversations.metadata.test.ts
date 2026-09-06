import { describe, expect, test } from "bun:test";
import { getConversationWithMeta } from "./conversations";
import { makeFakeDb } from "./testDb";

const OWNER = "users_owner";
const PARENT = "conversations_parent";
const conversation = (_id: string, fields = {}) => ({
  _id, user_id: OWNER, title: _id, started_at: 1, updated_at: 1, ...fields,
});

function fixture(children: any[], messages: any[] = []) {
  const db = makeFakeDb({
    users: [{ _id: OWNER, name: "Owner" }],
    conversations: [conversation(PARENT), ...children],
    messages,
  });
  const reads: Array<{ table: string; index?: string; count: number }> = [];
  const query = db.query.bind(db);
  db.query = (table: string) => {
    const q = query(table);
    let index: string | undefined;
    const withIndex = q.withIndex.bind(q);
    q.withIndex = (name: string, range: any) => {
      index = name;
      return withIndex(name, range);
    };
    for (const method of ["first", "take", "collect"]) {
      const run = q[method].bind(q);
      q[method] = async (...args: any[]) => {
        const result = await run(...args);
        reads.push({ table, index, count: Array.isArray(result) ? result.length : result ? 1 : 0 });
        return result;
      };
    }
    return q;
  };
  return {
    reads,
    run: (args = {}) => (getConversationWithMeta as any)._handler({
      db,
      auth: { getUserIdentity: async () => ({ subject: `${OWNER}|session` }) },
    }, { conversation_id: PARENT, ...args }),
  };
}

describe("conversation metadata read budget", () => {
  test("500 linked children retain every link without reading their transcripts", async () => {
    const children = Array.from({ length: 500 }, (_, i) => conversation(`conversations_child_${i}`, {
      parent_conversation_id: PARENT,
      parent_message_uuid: `spawn-${i}`,
      is_subagent: true,
      subagent_description: `Agent ${i}`,
    }));
    const f = fixture(children);
    const result = await f.run({ strip_volatile: true });
    expect(result.child_conversations).toHaveLength(500);
    expect(result.agent_name_entries).toHaveLength(500);
    expect(result.child_by_parent_uuid_entries).toHaveLength(500);
    expect(Object.fromEntries(result.child_by_parent_uuid_entries)["spawn-0"]).toBe("conversations_child_0");
    expect(f.reads.filter(r => r.table === "messages")).toHaveLength(0);
    expect(result.updated_at).toBeUndefined();
  });

  test("legacy matching has a fixed read budget and still links recent spawns", async () => {
    const children = Array.from({ length: 500 }, (_, i) => conversation(`conversations_child_${i}`, {
      parent_conversation_id: PARENT,
      is_subagent: true,
    }));
    const messages = children.map((c, i) => ({
      _id: `messages_child_${i}`, conversation_id: c._id,
      role: "user", content: `Investigate child ${i} independently`, timestamp: i,
    }));
    const f = fixture(children, [
      ...messages,
      ...Array.from({ length: 2500 }, (_, i) => ({
        _id: `messages_parent_${i}`, conversation_id: PARENT,
        message_uuid: `parent-${i}`, role: "assistant", timestamp: i,
        tool_calls: i === 2499 ? [{ name: "Agent", input: JSON.stringify({
          prompt: "Investigate child 499 independently", description: "Legacy agent",
        }) }] : undefined,
      })),
    ]);
    const result = await f.run();
    const messageReads = f.reads.filter(r => r.table === "messages");
    expect(result.child_conversations).toHaveLength(500);
    expect(messageReads.length).toBeLessThanOrEqual(25);
    expect(messageReads.reduce((sum, r) => sum + r.count, 0)).toBeLessThanOrEqual(224);
    expect(Object.fromEntries(result.child_by_parent_uuid_entries)["parent-2499"]).toBe("conversations_child_499");
    expect(Object.fromEntries(result.agent_name_entries)["Legacy agent"]).toBe("conversations_child_499");
  });

  test("fork previews skip assistant output and use the origin's copy of the fork point", async () => {
    const fork = conversation("conversations_fork", {
      forked_from: PARENT, parent_message_uuid: "fork-point", fork_cutoff_timestamp: 10,
    });
    const f = fixture([fork], [
      { _id: "messages_foreign", conversation_id: "conversations_other", message_uuid: "fork-point", role: "user", content: "Copied elsewhere", timestamp: 5000 },
      { _id: "messages_anchor", conversation_id: PARENT, message_uuid: "fork-point", role: "user", content: "Start", timestamp: 10 },
      ...Array.from({ length: 100 }, (_, i) => ({
        _id: `messages_noise_${i}`, conversation_id: fork._id, role: "assistant", content: "Tool output", timestamp: i + 11,
      })),
      { _id: "messages_fork_prompt", conversation_id: fork._id, role: "user", content: "Investigate the alternative", timestamp: 200 },
      { _id: "messages_origin_prompt", conversation_id: PARENT, role: "user", content: "Keep the original approach", timestamp: 200 },
    ]);
    const result = await f.run();
    expect(result.fork_children[0].first_divergent_preview).toBe("Investigate the alternative");
    expect(result.main_divergent_previews_by_fork["fork-point"]).toBe("Keep the original approach");
    expect(f.reads.filter(r => r.table === "messages").reduce((sum, r) => sum + r.count, 0)).toBe(3);
  });

  test("sibling forks with no origin preview share one fork-point lookup", async () => {
    const forks = Array.from({ length: 12 }, (_, i) => conversation(`conversations_fork_${i}`, {
      forked_from: PARENT, parent_message_uuid: "fork-point", fork_cutoff_timestamp: 10,
    }));
    const f = fixture(forks, [{
      _id: "messages_anchor", conversation_id: PARENT, message_uuid: "fork-point", role: "user", content: "Start", timestamp: 10,
    }]);
    const result = await f.run();
    expect(result.fork_children).toHaveLength(12);
    expect(result.main_divergent_previews_by_fork).toEqual({});
    expect(f.reads.filter(r => r.index === "by_conversation_uuid")).toHaveLength(1);
  });
});
