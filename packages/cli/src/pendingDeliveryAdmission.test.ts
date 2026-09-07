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

  test("a successful claim stands for the whole attempt", async () => {
    const svc = service([{ _id: "m1" }, null]);
    const admit = createDeliveryAdmission(svc, "m1", "conv");
    await admit();
    await admit(); // the fallback path, after this attempt's own "injected" mark
    await admit();
    expect(svc.calls).toEqual(["m1"]);
  });

  test("a refused claim throws and is asked again next time", async () => {
    const svc = service([null, { _id: "m1" }]);
    const admit = createDeliveryAdmission(svc, "m1", "conv");
    await expect(admit()).rejects.toBeInstanceOf(PendingDeliveryHeldError);
    await admit();
    expect(svc.calls).toEqual(["m1", "m1"]);
  });

  test("each attempt admits on its own", async () => {
    const svc = service([{ _id: "m1" }, { _id: "m1" }]);
    await createDeliveryAdmission(svc, "m1", "conv")();
    await createDeliveryAdmission(svc, "m1", "conv")();
    expect(svc.calls).toEqual(["m1", "m1"]);
  });
});
