import { describe, expect, test } from "bun:test";
import type { SecretMeta } from "@codecast/shared/contracts/secrets";
import { askFirstOffLedger, declineLedger, deleteLedger, rotateLedger } from "../../lib/secretLedgers";

const row = { _id: "s1", short_id: "sec-1", name: "zz-key", kind: "key", status: "ready", workspace: "user:u1", created_by: "u1", created_at: 0, updated_at: 0, use_count: 0 } as unknown as SecretMeta;

describe("confirm ledgers", () => {
  test("the audience figure names who, never a count that reads as agents", () => {
    for (const ledger of [deleteLedger(row, null), askFirstOffLedger(row, null), rotateLedger(row, null)]) {
      expect(ledger.figures[0]!.value).toBe("Only you");
      expect(ledger.figures[1]).toEqual({ value: "0", label: "agent reads so far" });
    }
    expect(deleteLedger(row, { name: "Union", people: 6 }).figures[0]).toMatchObject({ value: "Union", label: "6 people's agents lose it" });
  });

  test("Replace says when agents switch once, as a row", () => {
    const rows = rotateLedger(row, null).rows.map((r) => r.k);
    expect(rows).toEqual(["Env vars", "From", "Current", "To undo"]);
  });

  test("Decline says the asking session wakes told no, and names who asked and why", () => {
    const ledger = declineLedger({ ...row, status: "requested", requested_by_name: "Ana", request_why: "refund order 123" });
    expect(ledger.subject).toBe("Asked by Ana");
    expect(ledger.rows.map((r) => r.k)).toEqual(["For", "Its session", "To undo"]);
  });
});
