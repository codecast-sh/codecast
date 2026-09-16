import { afterEach, beforeEach, expect, test } from "bun:test";
import { convBucketMap, useInboxStore } from "../inboxStore";

const sessionId = "jx70000000000000000000000000test";
const bucketId = "bucket00000000000000000000000000";
const otherBucketId = "bucket11111111111111111111111111";
const calls: { action: string; args: any[]; result: any }[] = [];
const dispatchOwner = {};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  calls.length = 0;
  useInboxStore.setState({
    sessions: {}, conversations: {}, buckets: {}, bucketAssignments: {}, pending: {},
    pendingSessionCreates: {}, activeBucketFilter: null, chipFilterExclude: false,
  });
  useInboxStore.getState()._setDispatch(async (action, args, _patches, result) => {
    calls.push({ action, args, result });
    if (action === "createBucket") return {
      receiptVersion: 1, commandId: result.commandId, commandName: "buckets.create/v2",
      status: "acknowledged", result: { bucketId }, coverage: [], retryUntil: null,
    };
    return undefined;
  }, { owner: dispatchOwner });
});

afterEach(async () => {
  await settle();
  useInboxStore.getState()._clearDispatch(dispatchOwner);
});

function blank() {
  return useInboxStore.getState().beginOptimisticSession({
    agentType: "claude_code", deferCreate: true,
    create: async () => sessionId,
  });
}

function filing() {
  return convBucketMap(useInboxStore.getState().bucketAssignments);
}

function syncLabel(name = "Chosen label") {
  useInboxStore.getState().syncTable("buckets", [{
    _id: bucketId, name, created_at: 1, updated_at: Date.now(),
  }]);
}

test("a deferred blank shows its label immediately and files when created", async () => {
  const session = blank();
  useInboxStore.getState().assignSessionToBucket(session.stubId, bucketId);
  expect(filing()[session.stubId]).toBe(bucketId);
  expect(useInboxStore.getState().sessions[session.stubId]._postCreateBucketId).toBe(bucketId);
  expect(useInboxStore.getState().pendingSessionCreates[session.stubId]).toBeUndefined();
  await session.materialize();
  await settle();
  expect(filing()[sessionId]).toBe(bucketId);
  expect(calls.some((call) => call.action === "assignSessionToBucket" && call.args[0] === sessionId && call.args[1] === bucketId)).toBe(true);
});

test("changing the label before creation preserves only the latest choice", async () => {
  const session = blank();
  useInboxStore.getState().assignSessionToBucket(session.stubId, bucketId);
  useInboxStore.getState().assignSessionToBucket(session.stubId, otherBucketId);
  await session.materialize();
  await settle();
  expect(filing()[sessionId]).toBe(otherBucketId);
  expect(calls.filter((call) => call.action === "assignSessionToBucket" && call.args[0] === sessionId).map((call) => call.args[1])).toEqual([otherBucketId]);
});

test("removing a label before creation cancels the saved choice", async () => {
  const session = blank();
  useInboxStore.getState().assignSessionToBucket(session.stubId, bucketId);
  useInboxStore.getState().assignSessionToBucket(session.stubId, null);
  expect(useInboxStore.getState().sessions[session.stubId]._postCreateBucketId).toBeUndefined();
  await session.materialize();
  await settle();
  expect(filing()[sessionId]).toBeUndefined();
  expect(calls.filter((call) => call.action === "assignSessionToBucket" && call.args[0] === sessionId)).toHaveLength(0);
});

test("manual filing survives session sync after a reload without a create promise", async () => {
  const session = blank();
  useInboxStore.getState().assignSessionToBucket(session.stubId, bucketId);
  useInboxStore.getState().syncTable("sessions", [{
    ...useInboxStore.getState().sessions[session.stubId],
    _id: sessionId, session_id: session.stubId, _postCreateBucketId: undefined,
  }]);
  await settle();
  expect(filing()[sessionId]).toBe(bucketId);
  expect(calls.some((call) => call.action === "assignSessionToBucket" && call.args[0] === sessionId)).toBe(true);
});

for (const labelFirst of [true, false]) {
  test(`creating a label on a blank survives ${labelFirst ? "label" : "session"} syncing first`, async () => {
    const session = blank();
    const created = useInboxStore.getState().createBucket({ name: "Chosen label" }, {
      version: 1, kind: "assignBucket", conversationIds: [session.stubId],
    });
    const labelStub = filing()[session.stubId]!;
    expect(useInboxStore.getState().buckets[labelStub]?.name).toBe("Chosen label");
    expect(useInboxStore.getState().sessions[session.stubId]._postCreateBucketId).toBe(labelStub);
    await created;
    expect(calls.find((call) => call.action === "createBucket")?.result.localResult.continuation).toBeUndefined();
    if (labelFirst) {
      syncLabel();
      await settle();
      await session.materialize();
    } else {
      await session.materialize();
      await settle();
      expect(calls.filter((call) => call.action === "assignSessionToBucket" && call.args[0] === sessionId)).toHaveLength(0);
      syncLabel();
    }
    await settle();
    expect(filing()[sessionId]).toBe(bucketId);
    expect(calls.some((call) => call.action === "assignSessionToBucket" && call.args[0] === sessionId && call.args[1] === bucketId)).toBe(true);
  });
}

test("mixed selection sends only real session ids to the create-label receipt", async () => {
  const session = blank();
  await useInboxStore.getState().createBucket({ name: "Chosen label" }, {
    version: 1, kind: "assignBucket", conversationIds: [session.stubId, sessionId],
  });
  expect(calls.find((call) => call.action === "createBucket")?.result.localResult.continuation.conversationIds).toEqual([sessionId]);
  expect(filing()[session.stubId]).toStartWith("bucketstub-");
});

test("rejecting a new label clears its draft assignment", async () => {
  const session = blank();
  await useInboxStore.getState().createBucket({ name: "Chosen label" }, {
    version: 1, kind: "assignBucket", conversationIds: [session.stubId],
  });
  const localResult = calls.find((call) => call.action === "createBucket")!.result.localResult;
  (useInboxStore.getState() as any)._handleReceiptRejection("createBucket", localResult);
  expect(filing()[session.stubId]).toBeUndefined();
  expect(useInboxStore.getState().sessions[session.stubId]._postCreateBucketId).toBeUndefined();
});

test("rejecting a replacement label restores the earlier choice", async () => {
  const session = blank();
  useInboxStore.getState().assignSessionToBucket(session.stubId, otherBucketId);
  await useInboxStore.getState().createBucket({ name: "Chosen label" }, {
    version: 1, kind: "assignBucket", conversationIds: [session.stubId],
  });
  const localResult = calls.find((call) => call.action === "createBucket")!.result.localResult;
  await session.materialize();
  await settle();
  (useInboxStore.getState() as any)._handleReceiptRejection("createBucket", localResult);
  expect(filing()[sessionId]).toBe(otherBucketId);
  expect(useInboxStore.getState().sessions[sessionId]._postCreateBucketId).toBe(otherBucketId);
  await settle();
  expect(calls.some((call) => call.action === "assignSessionToBucket" && call.args[0] === sessionId && call.args[1] === otherBucketId)).toBe(true);
  useInboxStore.getState().syncTable("bucketAssignments", [{
    _id: "assignment0000000000000000000000", conversation_id: sessionId,
    bucket_id: otherBucketId, updated_at: Date.now(),
  }]);
  expect(filing()[sessionId]).toBe(otherBucketId);
});

test("creating a replacement label reconciles after both server echoes", async () => {
  const session = blank();
  useInboxStore.getState().assignSessionToBucket(session.stubId, otherBucketId);
  await useInboxStore.getState().createBucket({ name: "Chosen label" }, {
    version: 1, kind: "assignBucket", conversationIds: [session.stubId],
  });
  syncLabel();
  await session.materialize();
  await settle();
  useInboxStore.getState().syncTable("bucketAssignments", [{
    _id: "assignment0000000000000000000000", conversation_id: sessionId,
    bucket_id: bucketId, updated_at: Date.now(),
  }]);
  expect(filing()[sessionId]).toBe(bucketId);
  expect(Object.values(useInboxStore.getState().pending).some((entry: any) => entry.type === "field" && String(entry.value).startsWith("bucketstub-"))).toBe(false);
});
