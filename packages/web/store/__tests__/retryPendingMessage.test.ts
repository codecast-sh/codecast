import { afterEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";

describe("retry the existing pending message", () => {
  afterEach(() => useInboxStore.getState()._clearRuntimeBindings());

  test("keeps the original text and attachments and dispatches its client identity", async () => {
    const calls: any[] = [];
    useInboxStore.setState({ pendingMessages: { conv: [{
      _id: "client", _clientId: "client", role: "user", content: "original text", timestamp: 1,
      _isOptimistic: true, _isFailed: true, images: [{ storage_id: "image" }],
    }] as any }, pending: {} });
    useInboxStore.getState()._setDispatch(async (...args: any[]) => { calls.push(args); return "pending"; });
    const result = useInboxStore.getState().retryPendingMessage("conv", { clientId: "client" });
    expect(useInboxStore.getState().pendingMessages.conv).toHaveLength(1);
    expect(useInboxStore.getState().pendingMessages.conv[0]).toMatchObject({ content: "original text", images: [{ storage_id: "image" }] });
    expect(useInboxStore.getState().pendingMessages.conv[0]._isFailed).toBe(true);
    expect(await result).toBe("pending");
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(["retryPendingMessage", ["conv", { clientId: "client" }]]);
  });

  test("server-backed retry uses the queue id and creates no optimistic copy", async () => {
    useInboxStore.setState({ pendingMessages: {}, pending: {} });
    const calls: any[] = [];
    useInboxStore.getState()._setDispatch(async (...args: any[]) => { calls.push(args); return "pending"; });
    await useInboxStore.getState().retryPendingMessage("conv", { messageId: "server-id" });
    expect(useInboxStore.getState().pendingMessages).toEqual({});
    expect(calls[0].slice(0, 2)).toEqual(["retryPendingMessage", ["conv", { messageId: "server-id" }]]);
  });
});
