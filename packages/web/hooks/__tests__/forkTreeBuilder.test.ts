import { test, expect, describe } from "bun:test";
import {
  buildForkFamily,
  branchDisplayLabel,
  branchDisplayCount,
  type ForkConversationLike,
} from "../useForkTree";

// Minimal InboxSession-shaped stubs. buildForkFamily only reads the fork fields
// plus a few scalars, so we cast loosely rather than building full sessions.
function sess(id: string, forkedFrom: string | null, extra: Record<string, any> = {}) {
  return {
    _id: id,
    session_id: id,
    forked_from: forkedFrom,
    title: extra.title ?? "Same Title",
    message_count: extra.message_count ?? 10,
    started_at: extra.started_at ?? 0,
    updated_at: extra.updated_at ?? 0,
    agent_type: extra.agent_type ?? "claude_code",
    is_idle: true,
    has_pending: false,
    parent_message_uuid: extra.parent_message_uuid,
    fork_copied: extra.fork_copied,
    ...extra,
  } as any;
}

function ids(flat: ReturnType<typeof buildForkFamily>) {
  return flat.map((n) => ({ id: n.id, depth: n.depth, guides: n.guides, isLast: n.isLast }));
}

describe("buildForkFamily — tree shape", () => {
  // root
  //  ├─ A
  //  │   └─ A1   (grandchild → depth 2)
  //  └─ B
  const sessions = {
    root: sess("root", null, { started_at: 1 }),
    A: sess("A", "root", { started_at: 2 }),
    A1: sess("A1", "A", { started_at: 3 }),
    B: sess("B", "root", { started_at: 4 }),
  };
  const conv: ForkConversationLike = { _id: "A1", forked_from: "A", message_count: 10, started_at: 3 };

  test("renders multiple levels of indent (depth grows past 1)", () => {
    const flat = buildForkFamily(conv, sessions);
    const byId = Object.fromEntries(flat.map((n) => [n.id, n]));
    // Viewed from the deep grandchild, the whole family roots correctly.
    expect(flat.map((n) => n.id).sort()).toEqual(["A", "A1", "B", "root"]);
    expect(byId.root.depth).toBe(0);
    expect(byId.A.depth).toBe(1);
    expect(byId.A1.depth).toBe(2); // <-- multi-level indent
    expect(byId.B.depth).toBe(1);
  });

  test("DFS order: parent immediately precedes its own subtree", () => {
    const flat = buildForkFamily(conv, sessions);
    const order = flat.map((n) => n.id);
    // root, then A and A's subtree (A1) before sibling B.
    expect(order).toEqual(["root", "A", "A1", "B"]);
  });

  test("rail guides encode ancestor continuation", () => {
    const flat = buildForkFamily(conv, sessions);
    const byId = Object.fromEntries(flat.map((n) => [n.id, n]));
    // A is the first child of root with a sibling (B) below → not last.
    expect(byId.A.isLast).toBe(false);
    // A1 is A's only child → last; its guide column for the A level should be
    // false (A has no sibling below A1's branch line) since A1 sits under A and
    // B is a sibling of A, not of A1. Depth-2 node carries two guide columns.
    expect(byId.A1.guides.length).toBe(2);
    expect(byId.A1.isLast).toBe(true);
    // B is the last child of root → last.
    expect(byId.B.isLast).toBe(true);
  });
});

describe("buildForkFamily — labels & counts", () => {
  const sessions = {
    root: sess("root", null),
    A: sess("A", "root"),
    B: sess("B", "root"),
  };
  const conv: ForkConversationLike = { _id: "root", message_count: 10, started_at: 0 };

  test("server tree label wins and distinguishes same-titled siblings", () => {
    const serverTree = {
      id: "root",
      title: "Same Title",
      message_count: 100,
      started_at: 0,
      status: "active",
      branch_label: "the original ask",
      branch_message_count: 100,
      children: [
        {
          id: "A",
          title: "Same Title",
          message_count: 40,
          started_at: 1,
          status: "active",
          branch_label: "try the redis approach",
          branch_message_count: 12,
          children: [],
        },
        {
          id: "B",
          title: "Same Title",
          message_count: 60,
          started_at: 2,
          status: "active",
          branch_label: "what if we cache in memory",
          branch_message_count: 30,
          children: [],
        },
      ],
    };
    const flat = buildForkFamily(conv, sessions, serverTree as any);
    const byId = Object.fromEntries(flat.map((n) => [n.id, n]));
    // Titles collide; labels do not.
    expect(byId.A.title).toBe(byId.B.title);
    expect(branchDisplayLabel(byId.A)).toBe("try the redis approach");
    expect(branchDisplayLabel(byId.B)).toBe("what if we cache in memory");
    // After-fork counts come from the server.
    expect(branchDisplayCount(byId.A)).toBe(12);
    expect(branchDisplayCount(byId.B)).toBe(30);
  });

  test("client-cached messages produce labels without the server (deploy-independent)", () => {
    // A forked at message uuid 'm2'; its own messages follow.
    const messagesByConv: Record<string, any[]> = {
      A: [
        { role: "user", content: "shared history", message_uuid: "m1", timestamp: 1 },
        { role: "assistant", content: "...", message_uuid: "m2", timestamp: 2 },
        { role: "user", content: "<command-message>commit</command-message> branch prompt here", message_uuid: "m3", timestamp: 3 },
      ],
    };
    const sessA = {
      ...sessions,
      A: sess("A", "root", { parent_message_uuid: "m2" }),
    };
    const flat = buildForkFamily(conv, sessA, null, messagesByConv);
    const a = flat.find((n) => n.id === "A")!;
    // Tags stripped; first user message AFTER the fork point (m2) is used.
    expect(branchDisplayLabel(a)).toBe("commit branch prompt here");
  });

  test("falls back to title when nothing else is known", () => {
    // Fresh ids: the module-level label cache (which deliberately persists
    // labels across renders for the hop HUD) would otherwise carry over a
    // label set by an earlier test.
    const fresh = { rootF: sess("rootF", null), AF: sess("AF", "rootF") };
    const convF: ForkConversationLike = { _id: "rootF", message_count: 10, started_at: 0 };
    const flat = buildForkFamily(convF, fresh);
    const a = flat.find((n) => n.id === "AF")!;
    expect(branchDisplayLabel(a)).toBe("Same Title");
  });

  test("after-fork count falls back to message_count minus inherited history", () => {
    const fresh = { rootC: sess("rootC", null), AC: sess("AC", "rootC", { message_count: 50, fork_copied: 38 }) };
    const convC: ForkConversationLike = { _id: "rootC", message_count: 10, started_at: 0 };
    const flat = buildForkFamily(convC, fresh);
    const a = flat.find((n) => n.id === "AC")!;
    expect(branchDisplayCount(a)).toBe(12); // 50 - 38
  });
});
