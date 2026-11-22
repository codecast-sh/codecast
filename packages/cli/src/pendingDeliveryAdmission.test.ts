import { describe, expect, test } from "bun:test";
import { PendingDeliveryHeldError, createDeliveryAdmission } from "./pendingDeliveryAdmission.js";

// Shape of the 2026-09-07 strand: the terminal path marks the row "injected"
// before it pastes, the paste fails, and the auto-resume fallback in the SAME
// attempt asks for admission again. The server admits only "pending" rows, so
// the fallback was refused by the attempt's own mark and the message sat until
// the stale-injected healer re-pended it.
describe("createDeliveryAdmission", () => {
  function service(answers: Array<unknown>) {
    const calls: string[] = [];
    return {
      calls,
      claimPendingMessageForDelivery: async (id: string) => {
        calls.push(id);
        return answers.shift();
      },
    };
  }

  test("once the attempt marked the row injected, its claim stands for the fallback paths", async () => {
    const svc = service([{ _id: "m1" }, null]);
    let marked = false;
    const admit = createDeliveryAdmission(svc, "m1", "conv", () => marked);
    await admit();
    marked = true; // the first path's own "injected" mark, then its paste fails
    await admit(); // the fallback path
    await admit();
    expect(svc.calls).toEqual(["m1"]);
  });

  // ct-98180: the daemon fetched the row and claimed it, then a person
  // cancelled it while the daemon resolved the pane. The injection's own
  // admission asks again and nothing is typed into the agent.
  test("a cancel after the claim but before the paste stops the injection", async () => {
    const svc = service([{ _id: "m1" }, null]);
    const admit = createDeliveryAdmission(svc, "m1", "conv", () => false);
    await admit(); // admit_first
    await expect(admit()).rejects.toBeInstanceOf(PendingDeliveryHeldError); // admit_live, after the cancel
    expect(svc.calls).toEqual(["m1", "m1"]);
  });

  test("a refused claim throws and is asked again next time", async () => {
    const svc = service([null, { _id: "m1" }]);
    const admit = createDeliveryAdmission(svc, "m1", "conv", () => false);
    await expect(admit()).rejects.toBeInstanceOf(PendingDeliveryHeldError);
    await admit();
    expect(svc.calls).toEqual(["m1", "m1"]);
  });

  test("each attempt admits on its own", async () => {
    const svc = service([{ _id: "m1" }, { _id: "m1" }]);
    await createDeliveryAdmission(svc, "m1", "conv", () => false)();
    await createDeliveryAdmission(svc, "m1", "conv", () => false)();
    expect(svc.calls).toEqual(["m1", "m1"]);
  });
});

describe("the daemon's delivery", () => {
  test("re-claims before each injection until its own injected mark", async () => {
    const fs = await import("node:fs");
    const { functionBlock } = await import("./test-helpers/sourceRegion");
    const deliver = functionBlock(fs.readFileSync(new URL("./daemon.ts", import.meta.url), "utf8"), "deliverMessageIntoSession").text;
    expect(deliver).toContain("createDeliveryAdmission(syncService, messageId, conversationId, () => injectedMessageTs.has(messageId))");
    // Every injection path asks through the same admission, so a cancel that
    // lands between the claim and that path's paste stops it.
    for (const step of ["admit_first", "admit_app_server", "admit_sdk", "admit_claude_cloud", "admit_started", "admit_live", "admit_proc"]) {
      expect(deliver).toContain(`deliveryStep(messageId, "${step}", admit)`);
    }
    expect([...deliver.matchAll(/deliveryStep\(messageId, "admit_[a-z_]+", (\w+)\)/g)].map(m => m[1]).every(fn => fn === "admit")).toBe(true);
    const live = deliver.indexOf('deliveryStep(messageId, "admit_live", admit)');
    expect(deliver.indexOf("markInjectedBestEffort(", live)).toBeGreaterThan(live);
  });
});
