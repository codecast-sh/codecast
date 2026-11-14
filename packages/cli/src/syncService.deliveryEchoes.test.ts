import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncService } from "./syncService.js";
import { DeliveryEchoLedger, deliveryRecordUuid } from "./deliveryEchoLedger.js";

function service(refuseEchoIds = false) {
  const calls: Array<Record<string, any>> = [];
  const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "token" });
  (sync as any).client = {
    mutation: async (name: string, args: Record<string, any>) => {
      if (name !== "messages:addMessages") return null;
      calls.push(args);
      if (refuseEchoIds && "echo_ids" in args) {
        throw new Error("[CONVEX M(messages:addMessages)] ArgumentValidationError: Object contains extra field `echo_ids` that is not in the validator.\n\nObject: {...}");
      }
      return { inserted: args.messages.length, ids: args.messages.map((_: unknown, i: number) => `m${i}`) };
    },
  };
  sync.setDeliveryEchoes({
    stamp: (_conversationId, messages) => messages.map((m) => (m.content === "go" || m.content.startsWith('<session-message from="jx7abcd" delivery="pm9"') ? { ...m, deliveryIds: [m.content === "go" ? "pm1" : "pm9"] } : m)),
  });
  return { sync, calls };
}

const batch = [
  { messageUuid: "u1", role: "human" as const, content: "go", timestamp: 1 },
  { messageUuid: "a1", role: "assistant" as const, content: "going", timestamp: 2 },
];

describe("uploading echoes with their delivery ids", () => {
  test("a stamped turn carries its ids and the batch says the writer stamps", async () => {
    const { sync, calls } = service();
    await sync.addMessages({ conversationId: "c1", messages: batch });
    expect(calls).toHaveLength(1);
    expect(calls[0].echo_ids).toBe(true);
    expect(calls[0].messages.map((m: any) => m.delivery_ids ?? null)).toEqual([["pm1"], null]);
  });

  test("a server older than delivery ids gets the batch without them, from then on", async () => {
    const { sync, calls } = service(true);
    await sync.addMessages({ conversationId: "c1", messages: batch });
    await sync.addMessages({ conversationId: "c1", messages: batch });
    expect(calls.map((c) => "echo_ids" in c)).toEqual([true, false, false]);
    expect(calls.slice(1).every((c) => c.messages.every((m: any) => !("delivery_ids" in m)))).toBe(true);
  });

  test("a server that refused the ids is asked again once its deployment may have caught up", async () => {
    const { sync, calls } = service(true);
    await sync.addMessages({ conversationId: "c1", messages: batch });
    (sync as any).echoIdsRefusedAt = Date.now() - 11 * 60_000;
    await sync.addMessages({ conversationId: "c1", messages: batch });
    expect(calls.map((c) => "echo_ids" in c)).toEqual([true, false, true, false]);
  });

  test("the server gets the row's own words: a frame's id comes out, typed text is left alone", async () => {
    const { sync, calls } = service();
    const frame = '<session-message from="jx7abcd" delivery="pm9">\nrebase\n</session-message>';
    const typed = 'a fixture: <session-message from="x" delivery="pm9">';
    await sync.addMessages({ conversationId: "c1", messages: [
      { messageUuid: "u1", role: "human", content: frame, timestamp: 1 },
      { messageUuid: "u2", role: "human", content: typed, timestamp: 2 },
    ] });
    expect(calls[0].messages.map((m: any) => [m.content, m.delivery_ids ?? null])).toEqual([
      ['<session-message from="jx7abcd">\nrebase\n</session-message>', ["pm9"]],
      [typed, null],
    ]);
  });

  test("a framed turn no open delivery claims, a fork's copied history say, is stored without the id too", async () => {
    const { sync, calls } = service();
    await sync.addMessages({ conversationId: "c1", messages: [{ messageUuid: "u1", role: "human", content: '<session-message from="jx7abcd" delivery="k17fork">\nhi\n</session-message>', timestamp: 1 }] });
    expect(calls[0].messages[0].content).toBe('<session-message from="jx7abcd">\nhi\n</session-message>');
  });
});

describe("a send a busy Claude absorbed mid-turn", () => {
  test("its turn uploads with the delivery id it was sent under, and the sent uuid stays local", async () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-upload-"));
    const ledger = new DeliveryEchoLedger(join(dir, "ledger.sqlite"));
    try {
      const { sync, calls } = service();
      sync.setDeliveryEchoes(ledger);
      const sent = deliveryRecordUuid("pm-sdk", "codecast-sdk");
      ledger.expect({ messageId: "pm-sdk", conversationId: "c1", payload: "steer now", submittedAt: 1_000, exactUuid: sent });
      await sync.addMessages({ conversationId: "c1", messages: [
        { messageUuid: "f0000000-0000-4000-8000-00000000a001", sourceUuid: sent, role: "human", content: "steer now", timestamp: 2_000 },
      ] });
      const wire = calls[0].messages[0];
      expect(wire.message_uuid).toBe("f0000000-0000-4000-8000-00000000a001");
      expect(wire.delivery_ids).toEqual(["pm-sdk"]);
      expect(Object.keys(wire).some((k) => /source/i.test(k))).toBe(false);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a send a busy Claude absorbed mid-turn", () => {
  test("its turn uploads with the delivery id it was sent under, and the sent uuid stays local", async () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-upload-"));
    const ledger = new DeliveryEchoLedger(join(dir, "ledger.sqlite"));
    try {
      const { sync, calls } = service();
      sync.setDeliveryEchoes(ledger);
      const sent = deliveryRecordUuid("pm-sdk", "codecast-sdk");
      ledger.expect({ messageId: "pm-sdk", conversationId: "c1", payload: "steer now", submittedAt: 1_000, exactUuid: sent });
      await sync.addMessages({ conversationId: "c1", messages: [
        { messageUuid: "f0000000-0000-4000-8000-00000000a001", sourceUuid: sent, role: "human", content: "steer now", timestamp: 2_000 },
      ] });
      const wire = calls[0].messages[0];
      expect(wire.message_uuid).toBe("f0000000-0000-4000-8000-00000000a001");
      expect(wire.delivery_ids).toEqual(["pm-sdk"]);
      expect(Object.keys(wire).some((k) => /source/i.test(k))).toBe(false);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a send a busy Claude absorbed mid-turn", () => {
  test("its turn uploads with the delivery id it was sent under, and the sent uuid stays local", async () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-upload-"));
    const ledger = new DeliveryEchoLedger(join(dir, "ledger.sqlite"));
    try {
      const { sync, calls } = service();
      sync.setDeliveryEchoes(ledger);
      const sent = deliveryRecordUuid("pm-sdk", "codecast-sdk");
      ledger.expect({ messageId: "pm-sdk", conversationId: "c1", payload: "steer now", submittedAt: 1_000, exactUuid: sent });
      await sync.addMessages({ conversationId: "c1", messages: [
        { messageUuid: "f0000000-0000-4000-8000-00000000a001", sourceUuid: sent, role: "human", content: "steer now", timestamp: 2_000 },
      ] });
      const wire = calls[0].messages[0];
      expect(wire.message_uuid).toBe("f0000000-0000-4000-8000-00000000a001");
      expect(wire.delivery_ids).toEqual(["pm-sdk"]);
      expect(Object.keys(wire).some((k) => /source/i.test(k))).toBe(false);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a send a busy Claude absorbed mid-turn", () => {
  test("its turn uploads with the delivery id it was sent under, and the sent uuid stays local", async () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-upload-"));
    const ledger = new DeliveryEchoLedger(join(dir, "ledger.sqlite"));
    try {
      const { sync, calls } = service();
      sync.setDeliveryEchoes(ledger);
      const sent = deliveryRecordUuid("pm-sdk", "codecast-sdk");
      ledger.expect({ messageId: "pm-sdk", conversationId: "c1", payload: "steer now", submittedAt: 1_000, exactUuid: sent });
      await sync.addMessages({ conversationId: "c1", messages: [
        { messageUuid: "f0000000-0000-4000-8000-00000000a001", sourceUuid: sent, role: "human", content: "steer now", timestamp: 2_000 },
      ] });
      const wire = calls[0].messages[0];
      expect(wire.message_uuid).toBe("f0000000-0000-4000-8000-00000000a001");
      expect(wire.delivery_ids).toEqual(["pm-sdk"]);
      expect(Object.keys(wire).some((k) => /source/i.test(k))).toBe(false);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
