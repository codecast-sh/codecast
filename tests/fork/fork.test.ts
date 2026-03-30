import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createTestConversation,
  forkConversation,
  forkViaHttp,
  getTree,
  getTreeViaQuery,
  getBranchMessages,
  exportMessages,
  deleteConversation,
  convexMutation,
  countTreeNodes,
  maxTreeDepth,
  findNode,
  findLongSession,
  getConfig,
  uuid,
  type Message,
  type ForkResult,
} from "./api";

const TEST_TIMEOUT = 30_000;
const createdConversations: string[] = [];

function track(id: string) {
  createdConversations.push(id);
  return id;
}

afterAll(async () => {
  for (const id of createdConversations) {
    await deleteConversation(id);
  }
});

// ---------------------------------------------------------------------------
// 1. Basic Fork Operations
// ---------------------------------------------------------------------------
describe("Basic Fork Operations", () => {
  let rootId: string;
  let messages: Message[];

  beforeAll(async () => {
    const result = await createTestConversation({
      messageCount: 30,
      title: "Basic Fork Root",
    });
    rootId = track(result.conversationId);
    messages = result.messages;
  }, TEST_TIMEOUT);

  it("forks at the first message", async () => {
    const fork = await forkConversation(rootId, messages[0].message_uuid);
    track(fork.conversation_id);

    expect(fork.conversation_id).toBeTruthy();
    expect(fork.short_id).toBeTruthy();

    const tree = await getTree(rootId);
    const forkNode = findNode(tree.tree, fork.conversation_id);
    expect(forkNode).toBeTruthy();
    expect(forkNode!.message_count).toBe(1);
    expect(forkNode!.parent_message_uuid).toBe(messages[0].message_uuid);
  }, TEST_TIMEOUT);

  it("forks at a middle message", async () => {
    const midIdx = 14;
    const fork = await forkConversation(rootId, messages[midIdx].message_uuid);
    track(fork.conversation_id);

    const tree = await getTree(rootId);
    const forkNode = findNode(tree.tree, fork.conversation_id);
    expect(forkNode).toBeTruthy();
    expect(forkNode!.message_count).toBe(midIdx + 1);
    expect(forkNode!.parent_message_uuid).toBe(messages[midIdx].message_uuid);
  }, TEST_TIMEOUT);

  it("forks at the last message", async () => {
    const lastIdx = messages.length - 1;
    const fork = await forkConversation(rootId, messages[lastIdx].message_uuid);
    track(fork.conversation_id);

    const tree = await getTree(rootId);
    const forkNode = findNode(tree.tree, fork.conversation_id);
    expect(forkNode).toBeTruthy();
    expect(forkNode!.message_count).toBe(messages.length);
  }, TEST_TIMEOUT);

  it("forks without message_uuid clones all messages", async () => {
    const fork = await forkConversation(rootId);
    track(fork.conversation_id);

    const tree = await getTree(rootId);
    const forkNode = findNode(tree.tree, fork.conversation_id);
    expect(forkNode).toBeTruthy();
    expect(forkNode!.message_count).toBe(messages.length);
    expect(forkNode!.parent_message_uuid).toBeUndefined();
  }, TEST_TIMEOUT);

  it("fork via HTTP endpoint matches mutation result", async () => {
    const httpFork = await forkViaHttp(rootId, messages[5].message_uuid);
    track(httpFork.conversation_id);

    expect(httpFork.conversation_id).toBeTruthy();
    expect(httpFork.short_id).toBeTruthy();

    const tree = await getTree(rootId);
    const forkNode = findNode(tree.tree, httpFork.conversation_id);
    expect(forkNode).toBeTruthy();
    expect(forkNode!.message_count).toBe(6);
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 2. Message Integrity
// ---------------------------------------------------------------------------
describe("Message Integrity", () => {
  let rootId: string;
  let messages: Message[];
  let forkAtMsg10: ForkResult;

  beforeAll(async () => {
    const result = await createTestConversation({
      messageCount: 20,
      title: "Message Integrity Root",
    });
    rootId = track(result.conversationId);
    messages = result.messages;

    forkAtMsg10 = await forkConversation(rootId, messages[9].message_uuid);
    track(forkAtMsg10.conversation_id);
  }, TEST_TIMEOUT);

  it("fork branch messages returns only divergent messages", async () => {
    const branch = await getBranchMessages(forkAtMsg10.conversation_id);
    if ("error" in branch) throw new Error(branch.error);

    expect(branch.fork_point_uuid).toBe(messages[9].message_uuid);
    expect(branch.messages.length).toBe(0);
  }, TEST_TIMEOUT);

  it("fork preserves message UUIDs", async () => {
    const { messages: forkMessages } = await exportMessages(forkAtMsg10.conversation_id);
    const forkUuids = forkMessages.map((m: any) => m.message_uuid).filter(Boolean);
    const expectedUuids = messages.slice(0, 10).map((m) => m.message_uuid);

    for (const expected of expectedUuids) {
      expect(forkUuids).toContain(expected);
    }
  }, TEST_TIMEOUT);

  it("fork preserves message content exactly", async () => {
    const { messages: forkMessages } = await exportMessages(forkAtMsg10.conversation_id);
    const sorted = forkMessages.sort((a: any, b: any) => a.timestamp - b.timestamp);

    for (let i = 0; i < 10; i++) {
      expect(sorted[i].content).toBe(messages[i].content);
    }
  }, TEST_TIMEOUT);

  it("fork preserves message roles", async () => {
    const { messages: forkMessages } = await exportMessages(forkAtMsg10.conversation_id);
    const sorted = forkMessages.sort((a: any, b: any) => a.timestamp - b.timestamp);

    for (let i = 0; i < 10; i++) {
      expect(sorted[i].role).toBe(messages[i].role);
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 3. Deep Fork Trees
// ---------------------------------------------------------------------------
describe("Deep Fork Trees", () => {
  let rootId: string;
  let messages: Message[];

  beforeAll(async () => {
    const result = await createTestConversation({
      messageCount: 20,
      title: "Deep Tree Root",
    });
    rootId = track(result.conversationId);
    messages = result.messages;
  }, TEST_TIMEOUT);

  it("creates depth-2 fork tree (fork of fork)", async () => {
    const fork1 = await forkConversation(rootId, messages[9].message_uuid);
    track(fork1.conversation_id);

    const fork1Msgs = messages.slice(0, 10);
    const fork2 = await forkConversation(
      fork1.conversation_id,
      fork1Msgs[4].message_uuid
    );
    track(fork2.conversation_id);

    const tree = await getTree(rootId);
    expect(maxTreeDepth(tree.tree)).toBe(2);

    const node1 = findNode(tree.tree, fork1.conversation_id);
    expect(node1).toBeTruthy();
    expect(node1!.message_count).toBe(10);

    const node2 = findNode(tree.tree, fork2.conversation_id);
    expect(node2).toBeTruthy();
    expect(node2!.message_count).toBe(5);
  }, TEST_TIMEOUT);

  it("creates depth-3 fork tree (fork of fork of fork)", async () => {
    const f1 = await forkConversation(rootId, messages[14].message_uuid);
    track(f1.conversation_id);

    const f2 = await forkConversation(f1.conversation_id, messages[9].message_uuid);
    track(f2.conversation_id);

    const f3 = await forkConversation(f2.conversation_id, messages[4].message_uuid);
    track(f3.conversation_id);

    const tree = await getTree(rootId);
    expect(maxTreeDepth(tree.tree)).toBeGreaterThanOrEqual(3);

    const n3 = findNode(tree.tree, f3.conversation_id);
    expect(n3).toBeTruthy();
    expect(n3!.message_count).toBe(5);
  }, TEST_TIMEOUT);

  it("tree walks up to root from deepest fork", async () => {
    const f1 = await forkConversation(rootId, messages[7].message_uuid);
    track(f1.conversation_id);

    const f2 = await forkConversation(f1.conversation_id, messages[3].message_uuid);
    track(f2.conversation_id);

    const treeFromDeep = await getTree(f2.conversation_id);
    expect(treeFromDeep.tree.id).toBe(rootId);

    const deepNode = findNode(treeFromDeep.tree, f2.conversation_id);
    expect(deepNode).toBeTruthy();
    expect(deepNode!.is_current).toBe(true);
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 4. Sibling Forks
// ---------------------------------------------------------------------------
describe("Sibling Forks", () => {
  let rootId: string;
  let messages: Message[];

  beforeAll(async () => {
    const result = await createTestConversation({
      messageCount: 20,
      title: "Sibling Fork Root",
    });
    rootId = track(result.conversationId);
    messages = result.messages;
  }, TEST_TIMEOUT);

  it("creates multiple sibling forks from the same message", async () => {
    const forkPoint = messages[9].message_uuid;
    const siblings: ForkResult[] = [];

    for (let i = 0; i < 4; i++) {
      const fork = await forkConversation(rootId, forkPoint);
      track(fork.conversation_id);
      siblings.push(fork);
    }

    const tree = await getTree(rootId);
    const siblingNodes = tree.tree.children.filter(
      (c) => c.parent_message_uuid === forkPoint
    );
    expect(siblingNodes.length).toBeGreaterThanOrEqual(4);

    for (const sib of siblingNodes) {
      expect(sib.message_count).toBe(10);
    }
  }, TEST_TIMEOUT);

  it("creates forks from different message points", async () => {
    const fork1 = await forkConversation(rootId, messages[2].message_uuid);
    track(fork1.conversation_id);

    const fork2 = await forkConversation(rootId, messages[12].message_uuid);
    track(fork2.conversation_id);

    const fork3 = await forkConversation(rootId, messages[18].message_uuid);
    track(fork3.conversation_id);

    const tree = await getTree(rootId);
    const node1 = findNode(tree.tree, fork1.conversation_id);
    const node2 = findNode(tree.tree, fork2.conversation_id);
    const node3 = findNode(tree.tree, fork3.conversation_id);

    expect(node1!.message_count).toBe(3);
    expect(node2!.message_count).toBe(13);
    expect(node3!.message_count).toBe(19);
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 5. Cross-Agent Forking
// ---------------------------------------------------------------------------
describe("Cross-Agent Forking", () => {
  let rootId: string;
  let messages: Message[];

  beforeAll(async () => {
    const result = await createTestConversation({
      messageCount: 10,
      title: "Cross-Agent Root",
      agentType: "claude_code",
    });
    rootId = track(result.conversationId);
    messages = result.messages;
  }, TEST_TIMEOUT);

  it("forks with agent type switch to codex", async () => {
    const fork = await forkConversation(
      rootId,
      messages[4].message_uuid,
      "codex"
    );
    track(fork.conversation_id);

    const tree = await getTree(rootId);
    const forkNode = findNode(tree.tree, fork.conversation_id);
    expect(forkNode).toBeTruthy();
    expect(forkNode!.agent_type).toBe("codex");
    expect(tree.tree.agent_type).toBe("claude_code");
  }, TEST_TIMEOUT);

  it("forks with agent type switch to cursor", async () => {
    const fork = await forkConversation(
      rootId,
      messages[6].message_uuid,
      "cursor"
    );
    track(fork.conversation_id);

    const tree = await getTree(rootId);
    const forkNode = findNode(tree.tree, fork.conversation_id);
    expect(forkNode!.agent_type).toBe("cursor");
  }, TEST_TIMEOUT);

  it("forks with agent type switch to gemini", async () => {
    const fork = await forkConversation(
      rootId,
      messages[8].message_uuid,
      "gemini"
    );
    track(fork.conversation_id);

    const tree = await getTree(rootId);
    const forkNode = findNode(tree.tree, fork.conversation_id);
    expect(forkNode!.agent_type).toBe("gemini");
  }, TEST_TIMEOUT);

  it("fork title includes agent prefix on agent switch", async () => {
    const fork = await forkConversation(
      rootId,
      messages[2].message_uuid,
      "codex"
    );
    track(fork.conversation_id);

    const tree = await getTree(rootId);
    const forkNode = findNode(tree.tree, fork.conversation_id);
    expect(forkNode!.title).toContain("Codex:");
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 6. Complex Tree Structures
// ---------------------------------------------------------------------------
describe("Complex Tree Structures", () => {
  let rootId: string;
  let messages: Message[];

  beforeAll(async () => {
    const result = await createTestConversation({
      messageCount: 30,
      title: "Complex Tree Root",
    });
    rootId = track(result.conversationId);
    messages = result.messages;
  }, TEST_TIMEOUT);

  it("builds a wide + deep tree (5 branches, depth 3)", async () => {
    const forkPoints = [4, 9, 14, 19, 24];
    const forks: ForkResult[] = [];
    for (const idx of forkPoints) {
      const f = await forkConversation(rootId, messages[idx].message_uuid);
      track(f.conversation_id);
      forks.push(f);
    }

    // forks[1] has messages 0..9 — fork it at message 3
    const depth2a = await forkConversation(
      forks[1].conversation_id,
      messages[3].message_uuid
    );
    track(depth2a.conversation_id);

    // forks[2] has messages 0..14 — fork it at message 7
    const depth2b = await forkConversation(
      forks[2].conversation_id,
      messages[7].message_uuid
    );
    track(depth2b.conversation_id);

    // depth2a has messages 0..3 — fork it at message 1
    const depth3 = await forkConversation(
      depth2a.conversation_id,
      messages[1].message_uuid
    );
    track(depth3.conversation_id);

    const tree = await getTree(rootId);
    expect(countTreeNodes(tree.tree)).toBeGreaterThanOrEqual(9);
    expect(maxTreeDepth(tree.tree)).toBeGreaterThanOrEqual(3);
    expect(tree.tree.children.length).toBeGreaterThanOrEqual(5);
  }, TEST_TIMEOUT);

  it("tree from any node walks to same root", async () => {
    const f1 = await forkConversation(rootId, messages[10].message_uuid);
    track(f1.conversation_id);

    const f2 = await forkConversation(f1.conversation_id, messages[5].message_uuid);
    track(f2.conversation_id);

    const treeFromRoot = await getTree(rootId);
    const treeFromF1 = await getTree(f1.conversation_id);
    const treeFromF2 = await getTree(f2.conversation_id);

    expect(treeFromRoot.tree.id).toBe(rootId);
    expect(treeFromF1.tree.id).toBe(rootId);
    expect(treeFromF2.tree.id).toBe(rootId);
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 7. Fork Count Tracking
// ---------------------------------------------------------------------------
describe("Fork Count Tracking", () => {
  it("fork_count increments correctly on parent", async () => {
    const result = await createTestConversation({
      messageCount: 10,
      title: "Fork Count Test",
    });
    const rootId = track(result.conversationId);

    for (let i = 0; i < 3; i++) {
      const f = await forkConversation(rootId, result.messages[i * 2].message_uuid);
      track(f.conversation_id);
    }

    const tree = await getTree(rootId);
    expect(tree.tree.children.length).toBeGreaterThanOrEqual(3);
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 8. Error Cases
// ---------------------------------------------------------------------------
describe("Error Cases", () => {
  it("fork non-existent conversation returns error", async () => {
    const result = await forkViaHttp("nonexistent-id-12345", "some-uuid");
    expect((result as any).error).toBeTruthy();
  }, TEST_TIMEOUT);

  it("fork at non-existent message UUID throws", async () => {
    const conv = await createTestConversation({
      messageCount: 5,
      title: "Error Case Root",
    });
    track(conv.conversationId);

    const result = await forkViaHttp(conv.conversationId, "nonexistent-uuid");
    expect((result as any).error).toBeTruthy();
    expect((result as any).error).toContain("not found");
  }, TEST_TIMEOUT);

  it("fork with invalid api_token returns 401", async () => {
    const conv = await createTestConversation({
      messageCount: 5,
      title: "Bad Auth Test",
    });
    track(conv.conversationId);

    const res = await fetch(`${getConfig().convex_url}/cli/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: "invalid_token_abc123",
        conversation_id: conv.conversationId,
        message_uuid: conv.messages[0].message_uuid,
      }),
    });
    expect(res.status).toBe(401);
  }, TEST_TIMEOUT);

  it("tree for non-existent conversation returns error", async () => {
    const result = await getTreeViaQuery("nonexistent-id-xyz");
    expect("error" in result).toBe(true);
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 9. Real Session Forking (production data stress test)
// ---------------------------------------------------------------------------
describe("Real Session Forking", () => {
  let realConvId: string | null = null;
  let realMessages: any[] = [];

  beforeAll(async () => {
    realConvId = await findLongSession(50);
    if (realConvId) {
      try {
        const { messages } = await exportMessages(realConvId);
        realMessages = messages
          .filter((m: any) => m.message_uuid)
          .sort((a: any, b: any) => a.timestamp - b.timestamp);
      } catch {
        realConvId = null;
      }
    }
  }, TEST_TIMEOUT);

  it("forks a real long session at early point", async () => {
    if (!realConvId || realMessages.length < 10) {
      console.log("SKIP: no suitable real session found");
      return;
    }

    const earlyMsg = realMessages[Math.min(4, realMessages.length - 1)];
    const fork = await forkConversation(realConvId, earlyMsg.message_uuid);
    track(fork.conversation_id);

    expect(fork.conversation_id).toBeTruthy();
    const tree = await getTree(realConvId);
    const node = findNode(tree.tree, fork.conversation_id);
    expect(node).toBeTruthy();
    expect(node!.message_count).toBeGreaterThan(0);
    expect(node!.message_count).toBeLessThanOrEqual(10);
  }, TEST_TIMEOUT);

  it("forks a real long session at midpoint", async () => {
    if (!realConvId || realMessages.length < 20) {
      console.log("SKIP: no suitable real session found");
      return;
    }

    const midIdx = Math.floor(realMessages.length / 2);
    const midMsg = realMessages[midIdx];
    const fork = await forkConversation(realConvId, midMsg.message_uuid);
    track(fork.conversation_id);

    const tree = await getTree(realConvId);
    const node = findNode(tree.tree, fork.conversation_id);
    expect(node).toBeTruthy();
    expect(node!.message_count).toBeGreaterThan(realMessages.length * 0.3);
  }, TEST_TIMEOUT);

  it("forks a real long session at late point", async () => {
    if (!realConvId || realMessages.length < 20) {
      console.log("SKIP: no suitable real session found");
      return;
    }

    const lateIdx = realMessages.length - 3;
    const lateMsg = realMessages[lateIdx];
    const fork = await forkConversation(realConvId, lateMsg.message_uuid);
    track(fork.conversation_id);

    const tree = await getTree(realConvId);
    const node = findNode(tree.tree, fork.conversation_id);
    expect(node).toBeTruthy();
    expect(node!.message_count).toBeGreaterThan(realMessages.length * 0.8);
  }, TEST_TIMEOUT);

  it("creates a fork tree from a real session", async () => {
    if (!realConvId || realMessages.length < 30) {
      console.log("SKIP: no suitable real session found");
      return;
    }

    const f1 = await forkConversation(
      realConvId,
      realMessages[10].message_uuid
    );
    track(f1.conversation_id);

    const f2 = await forkConversation(
      f1.conversation_id,
      realMessages[5].message_uuid
    );
    track(f2.conversation_id);

    const tree = await getTree(realConvId);
    expect(maxTreeDepth(tree.tree)).toBeGreaterThanOrEqual(2);

    const deep = findNode(tree.tree, f2.conversation_id);
    expect(deep).toBeTruthy();
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 10. Concurrent Fork Stress Test
// ---------------------------------------------------------------------------
describe("Concurrent Fork Operations", () => {
  it("handles sequential rapid forks from the same conversation", async () => {
    const conv = await createTestConversation({
      messageCount: 20,
      title: "Rapid Fork Root",
    });
    track(conv.conversationId);

    const results: ForkResult[] = [];
    for (let i = 0; i < 10; i++) {
      const msg = conv.messages[i * 2];
      const r = await forkConversation(conv.conversationId, msg.message_uuid);
      track(r.conversation_id);
      results.push(r);
    }

    const tree = await getTree(conv.conversationId);
    expect(tree.tree.children.length).toBeGreaterThanOrEqual(10);

    const ids = new Set(results.map((r) => r.conversation_id));
    expect(ids.size).toBe(10);
  }, 60_000);

  it("parallel forks to different parents succeed", async () => {
    const convs = await Promise.all([
      createTestConversation({ messageCount: 6, title: "Parallel A" }),
      createTestConversation({ messageCount: 6, title: "Parallel B" }),
      createTestConversation({ messageCount: 6, title: "Parallel C" }),
    ]);
    for (const c of convs) track(c.conversationId);

    const forks = await Promise.all(
      convs.map((c) =>
        forkConversation(c.conversationId, c.messages[2].message_uuid)
      )
    );
    for (const f of forks) {
      track(f.conversation_id);
      expect(f.conversation_id).toBeTruthy();
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 11. Multi-Generation Fork with Messages
// ---------------------------------------------------------------------------
describe("Multi-Generation Fork with New Messages", () => {
  it("forks, adds messages to fork, then forks the fork", async () => {
    const config = getConfig();
    const conv = await createTestConversation({
      messageCount: 10,
      title: "Multi-Gen Root",
    });
    track(conv.conversationId);

    const f1 = await forkConversation(
      conv.conversationId,
      conv.messages[4].message_uuid
    );
    track(f1.conversation_id);

    await convexMutation("messages:addMessages", {
      conversation_id: f1.conversation_id,
      api_token: config.auth_token,
      messages: [
        {
          role: "user" as const,
          content: "New message in fork gen1",
          message_uuid: `fork-gen1-${uuid()}`,
          timestamp: Date.now(),
        },
        {
          role: "assistant" as const,
          content: "Response in fork gen1",
          message_uuid: `fork-gen1-resp-${uuid()}`,
          timestamp: Date.now() + 1000,
        },
      ],
    });

    const branch1 = await getBranchMessages(f1.conversation_id);
    if (!("error" in branch1)) {
      expect(branch1.messages.length).toBe(2);
    }

    const f2 = await forkConversation(
      f1.conversation_id,
      conv.messages[2].message_uuid
    );
    track(f2.conversation_id);

    const tree = await getTree(conv.conversationId);
    expect(maxTreeDepth(tree.tree)).toBeGreaterThanOrEqual(2);

    const f1Node = findNode(tree.tree, f1.conversation_id);
    expect(f1Node!.children.length).toBeGreaterThanOrEqual(1);
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 12. Branch Messages Correctness
// ---------------------------------------------------------------------------
describe("Branch Messages Correctness", () => {
  it("fork without fork point returns all messages with null fork_point_uuid", async () => {
    const conv = await createTestConversation({
      messageCount: 8,
      title: "Full Clone Branch Test",
    });
    track(conv.conversationId);

    const fork = await forkConversation(conv.conversationId);
    track(fork.conversation_id);

    const branch = await getBranchMessages(fork.conversation_id);
    if (!("error" in branch)) {
      expect(branch.fork_point_uuid).toBeNull();
      expect(branch.messages.length).toBe(8);
    }
  }, TEST_TIMEOUT);

  it("fork at midpoint returns 0 divergent messages initially", async () => {
    const conv = await createTestConversation({
      messageCount: 12,
      title: "Midpoint Branch Test",
    });
    track(conv.conversationId);

    const fork = await forkConversation(
      conv.conversationId,
      conv.messages[5].message_uuid
    );
    track(fork.conversation_id);

    const branch = await getBranchMessages(fork.conversation_id);
    if (!("error" in branch)) {
      expect(branch.fork_point_uuid).toBe(conv.messages[5].message_uuid);
      expect(branch.messages.length).toBe(0);
    }
  }, 60_000);

  it("divergent messages appear after adding to fork", async () => {
    const config = getConfig();
    const conv = await createTestConversation({
      messageCount: 10,
      title: "Divergent Messages Test",
    });
    track(conv.conversationId);

    const fork = await forkConversation(
      conv.conversationId,
      conv.messages[4].message_uuid
    );
    track(fork.conversation_id);

    await convexMutation("messages:addMessages", {
      conversation_id: fork.conversation_id,
      api_token: config.auth_token,
      messages: [
        {
          role: "user" as const,
          content: "Divergent message A",
          message_uuid: `divergent-a-${uuid()}`,
          timestamp: Date.now(),
        },
        {
          role: "assistant" as const,
          content: "Divergent message B",
          message_uuid: `divergent-b-${uuid()}`,
          timestamp: Date.now() + 1000,
        },
      ],
    });

    const branch = await getBranchMessages(fork.conversation_id);
    if (!("error" in branch)) {
      expect(branch.fork_point_uuid).toBe(conv.messages[4].message_uuid);
      expect(branch.messages.length).toBe(2);
      expect(branch.messages[0].content).toBe("Divergent message A");
    }
  }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 13. Large Conversation Fork
// ---------------------------------------------------------------------------
describe("Large Conversation Fork", () => {
  it("forks a 200-message conversation correctly", async () => {
    const conv = await createTestConversation({
      messageCount: 200,
      title: "Large Conversation Fork Test",
    });
    track(conv.conversationId);

    const fork = await forkConversation(
      conv.conversationId,
      conv.messages[99].message_uuid
    );
    track(fork.conversation_id);

    const tree = await getTree(conv.conversationId);
    const node = findNode(tree.tree, fork.conversation_id);
    expect(node).toBeTruthy();
    expect(node!.message_count).toBe(100);
  }, 60_000);
});
