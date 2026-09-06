import { expect, test } from "bun:test";
import { repair } from "./agentPromptRepair";
import { makeFakeDb } from "./testDb";
import { buildExistingMessagePatch } from "./messages";
import { parseInboundSessionMessage } from "../../web/components/sessionMessage";

const reviewed = {
  "parent": "jx7297y2rfkpskb14mgbsjm5e58dv709",
  "child": "jx7bcn4axn3dn2eamkq4ep6bdx8dwwp2",
  "entry": {
    "message_id": "k17ahy5yc1yn1dhm6fe9d5cw758dx608",
    "expected_content": "Eight annotations are applied; freeze new test now for one CLI rerun. No further source edits until release. Root uses separate scratch runner with41 external declaration inputs included. Results follow; no more fixture/runtime edits planned.",
    "source_message_id": "k17068qj25cj6pcpb2n3x1ekzs8dwfe9",
    "source_call_id": "exec-fc513651-b0b9-4015-87eb-2707a06c0c58",
    "expected_source_input": "{\"command\":\"/bin/bash -lc \\\"/Users/ashot/.claude/scripts/agent-send.sh impl-update-prompts 'Eight annotations are applied; freeze new test now for one CLI rerun. No further source edits until release. Root uses separate scratch runner with41 external declaration inputs included. Results follow; no more fixture/runtime edits planned.'\\\"\",\"cwd\":\"/Users/ashot/src/codecast\"}"
  }
};

function fixture() {
  const { parent, child, entry } = reviewed;
  const original = {
    _id: entry.message_id, conversation_id: child, message_uuid: "stable-uuid",
    role: "user", content: entry.expected_content, timestamp: 120, images: [{ data: "preserved" }],
  };
  const db = makeFakeDb({
    conversations: [
      { _id: parent, user_id: "owner" },
      { _id: child, user_id: "owner", parent_conversation_id: parent, is_subagent: true, transcript_revision: 2, updated_at: 999 },
    ],
    messages: [original, {
      _id: entry.source_message_id, conversation_id: parent, role: "assistant", timestamp: 125,
      tool_calls: [{ id: entry.source_call_id, input: entry.expected_source_input }],
    }],
    message_search_recent: [{ _id: "mirror", message_id: original._id, content: original.content }],
  });
  const args = { parent_conversation_id: parent, child_conversation_id: child, entries: [{ ...entry }] };
  return { db, args, original: { ...original }, run: (input: any = args) => (repair as any)._handler({ db }, input) };
}

test("reviewed repair previews, preserves row identity, refreshes history, and is idempotent across re-import", async () => {
  const f = fixture();
  expect(await f.run()).toEqual({ dry_run: true, changed: 1 });
  expect(await f.db.get(f.original._id)).toEqual(f.original);
  expect(await f.run({ ...f.args, dry_run: false })).toEqual({ dry_run: false, changed: 1 });
  const target = await f.db.get(f.original._id);
  expect({ ...target, content: f.original.content }).toEqual(f.original);
  expect(parseInboundSessionMessage(target.content)).toEqual({ from: reviewed.parent, body: f.original.content, name: undefined });
  expect(target.content).toContain(`source-message="${reviewed.entry.source_message_id}"`);
  expect((await f.db.get("mirror")).content).toBe(target.content);
  expect(await f.db.get(reviewed.child)).toMatchObject({ transcript_revision: 3, updated_at: 999 });
  expect(await f.run({ ...f.args, dry_run: false })).toEqual({ dry_run: false, changed: 0 });
  expect((await f.db.get(reviewed.child)).transcript_revision).toBe(3);
  expect(buildExistingMessagePatch(target, { role: "user", content: f.original.content })).toBeNull();
});

for (const [label, id, patch] of [
  ["known human", reviewed.entry.message_id, { from_user_id: "owner" }],
  ["stale content", reviewed.entry.message_id, { content: "Human replacement" }],
  ["wrong child", reviewed.entry.message_id, { conversation_id: "elsewhere" }],
  ["wrong owner", reviewed.child, { user_id: "someone" }],
  ["wrong parent", reviewed.child, { parent_conversation_id: "elsewhere" }],
  ["root session", reviewed.child, { is_subagent: false }],
  ["unrelated source", reviewed.entry.source_message_id, { conversation_id: "elsewhere" }],
  ["human source", reviewed.entry.source_message_id, { role: "user" }],
  ["changed source", reviewed.entry.source_message_id, { tool_calls: [{ id: reviewed.entry.source_call_id, input: "agent-send.sh worker changed" }] }],
  ["old source", reviewed.entry.source_message_id, { timestamp: -500000 }],
] as const) test(`refuses ${label} before any repair`, async () => {
  const f = fixture();
  await f.db.patch(id, patch);
  const before = JSON.stringify(f.db._tables);
  await expect(f.run({ ...f.args, dry_run: false })).rejects.toThrow();
  expect(JSON.stringify(f.db._tables)).toBe(before);
});

for (const mismatch of ["wrong body", "sibling target", "unmarked human", "sibling source"] as const) {
  test(`valid same-parent helper cannot authorize ${mismatch}`, async () => {
    const f = fixture();
    const entry = { ...reviewed.entry };
    if (mismatch === "wrong body") {
      entry.expected_content = "Unrelated human body";
      await f.db.patch(entry.message_id, { content: entry.expected_content });
    } else if (mismatch === "sibling source") {
      entry.expected_source_input = entry.expected_source_input.replace("impl-update-prompts", "impl-update-client");
      await f.db.patch(entry.source_message_id, { tool_calls: [{ id: entry.source_call_id, input: entry.expected_source_input }] });
    } else {
      entry.message_id = await f.db.insert("messages", {
        conversation_id: mismatch === "sibling target" ? "sibling" : reviewed.child,
        role: "user", content: entry.expected_content, timestamp: 120,
      });
      if (mismatch === "sibling target") {
        f.db._tables.conversations.push({ _id: "sibling", user_id: "owner", parent_conversation_id: reviewed.parent, is_subagent: true });
        f.args.child_conversation_id = "sibling";
      }
    }
    const before = JSON.stringify(f.db._tables);
    await expect(f.run({ ...f.args, entries: [entry], dry_run: false })).rejects.toThrow("tuple was not reviewed");
    expect(JSON.stringify(f.db._tables)).toBe(before);
  });
}

test("validates the complete batch before writing and rejects duplicate or oversized batches", async () => {
  for (const entries of [
    [reviewed.entry, { ...reviewed.entry, message_id: "missing" }],
    Array(2).fill(reviewed.entry),
    Array(33).fill(reviewed.entry),
    [{ ...reviewed.entry, expected_content: "x".repeat(512_001) }],
  ]) {
    const f = fixture();
    await expect(f.run({ ...f.args, entries, dry_run: false })).rejects.toThrow();
    expect(await f.db.get(f.original._id)).toEqual(f.original);
  }
});
