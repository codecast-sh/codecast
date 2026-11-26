// A re-ask's `reask_at` is the window's own mark: a server push keeps it, it holds no lock waiting for an echo the
// server never sends, and a refused re-ask clears it for good.
import { expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";

const row = (over: Record<string, unknown> = {}) => ({ _id: "d1", conversation_id: "c1", session_id: "s", question: "Ship?", options: [], status: "pending", created_at: 1, ...over });

test("a refused re-ask's stamp stays cleared through the next push", () => {
  useInboxStore.setState({ sessionDecisions: { d1: row() as any }, decisionDetails: {} } as any);
  void useInboxStore.getState().reaskDecision("d1").catch(() => {});
  expect(useInboxStore.getState().sessionDecisions.d1.reask_at).toBeGreaterThan(0);
  // A push while it asks keeps the stamp.
  useInboxStore.getState().syncTable("sessionDecisions", [row({ question: "Ship it?" })], { isDelta: true } as any);
  expect(useInboxStore.getState().sessionDecisions.d1.reask_at).toBeGreaterThan(0);
  useInboxStore.getState().reaskRefused("d1");
  useInboxStore.getState().syncTable("sessionDecisions", [row({ question: "Ship it now?" })], { isDelta: true } as any);
  expect(useInboxStore.getState().sessionDecisions.d1.reask_at).toBeUndefined();
});

test("the detail's stamp survives a push of the detail", () => {
  const detail = { _id: "d2", decision: row({ _id: "d2" }), doc: null };
  useInboxStore.setState({ sessionDecisions: {}, decisionDetails: { d2: detail } } as any);
  void useInboxStore.getState().reaskDecision("d2").catch(() => {});
  useInboxStore.getState().syncTable("decisionDetails", [{ ...detail, doc: { _id: "x", content: "new" } }], { isDelta: true } as any);
  expect((useInboxStore.getState().decisionDetails as any).d2.reask_at).toBeGreaterThan(0);
});
