import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ct-98180: every cancel button goes through cancelPendingSend. Only an
// answer that the message was taken back puts the text back in the composer;
// every answer that the agent may hold it, or may still get it, shows a
// warning and leaves the composer alone.
const toasts: string[] = [];
const sonner = await import("sonner");
mock.module("sonner", () => ({
  ...sonner,
  toast: Object.assign((m: string) => toasts.push(`note:${m}`), {
    info: (m: string) => toasts.push(`info:${m}`),
    error: (m: string) => toasts.push(`err:${m}`),
    success: (m: string) => toasts.push(`ok:${m}`),
  }),
}));

const { useInboxStore } = await import("../../store/inboxStore");
const { cancelPendingSend } = await import("../cancelPendingSend");

function answer(result: string | Error) {
  useInboxStore.getState()._setDispatch(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

describe("cancelPendingSend", () => {
  beforeEach(() => {
    toasts.length = 0;
    useInboxStore.setState({ pendingMessages: {}, pending: {}, composerPrefill: null } as any);
  });
  afterEach(() => useInboxStore.getState()._clearRuntimeBindings());

  test("cancelled: no warning, the text comes back to the composer", async () => {
    answer("cancelled");
    expect(await cancelPendingSend("conv", { messageId: "msg" }, "do the thing")).toBe("cancelled");
    expect(toasts).toEqual([]);
    expect(useInboxStore.getState().composerPrefill).toEqual({ convId: "conv", text: "do the thing" });
  });

  for (const status of ["delivered", "injected", "unconfirmed"]) {
    test(`${status}: a warning, and the composer stays empty`, async () => {
      answer(status);
      await cancelPendingSend("conv", { messageId: "msg" }, "do the thing");
      expect(toasts).toEqual(["info:This message may already have reached the session"]);
      expect(useInboxStore.getState().composerPrefill).toBeNull();
    });
  }

  test("not_found by client id (the send may still be on its way): a warning", async () => {
    answer("not_found");
    await cancelPendingSend("conv", { clientId: "client" }, "do the thing");
    expect(toasts).toEqual(["info:This message may already have reached the session"]);
    expect(useInboxStore.getState().composerPrefill).toBeNull();
  });

  test("not_found by server id: nothing left to deliver, no warning", async () => {
    answer("not_found");
    await cancelPendingSend("conv", { messageId: "msg" }, "do the thing");
    expect(toasts).toEqual([]);
  });

  test("a refused cancel (already being delivered) reaches the caller with no prefill", async () => {
    // A mutation that throws reaches the client as "Uncaught Error: …".
    answer(new Error("Uncaught Error: This message is already being delivered to the session"));
    await expect(cancelPendingSend("conv", { messageId: "msg" }, "do the thing")).rejects.toThrow("already being delivered");
    expect(useInboxStore.getState().composerPrefill).toBeNull();
  });
});
