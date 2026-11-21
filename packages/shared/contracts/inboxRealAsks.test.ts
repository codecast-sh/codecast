import { describe, expect, test } from "bun:test";
import { DORMANT_CLAIM_TTL_MS } from "./agentStatus";
import { placeProjectableRow, shouldShowInInbox } from "./inboxProjection";

const EPOCH = 1_800_000_000_000;
const HOUR = 3_600_000;

const dormant = (extra: Record<string, any> = {}) => ({
  _id: "d",
  status: "active",
  title: "Meta-optimize the climb",
  message_count: 40,
  is_idle: true,
  agent_status: "dormant",
  updated_at: EPOCH - (DORMANT_CLAIM_TTL_MS + 9 * HOUR),
  ...extra,
});

describe("ct-59116: the inbox holds only what the viewer can act on", () => {
  test("a dormant session whose bound task has an open blocker stays dormant past the claim TTL", () => {
    const blocked = dormant({
      active_task: { _id: "t", short_id: "ct-96184", title: "Meta-optimize", status: "in_progress", blocked: true },
    });
    expect(placeProjectableRow(blocked as any, false, EPOCH).bucket).toBe("dormant");
  });

  test("a dormant session with nothing able to wake it still reaches needs_input", () => {
    const bare = dormant({ active_task: { _id: "t", short_id: "ct-1", title: "x", status: "in_progress" } });
    expect(placeProjectableRow(bare as any, false, EPOCH).bucket).toBe("needs_input");
  });

  test("cast doctor e2e probe sessions never show in the inbox", () => {
    const probe = { _id: "p", status: "active", title: "Stray input check", message_count: 2, updated_at: EPOCH, project_path: "/home/u/.codecast/doctor/e2e-abc123" };
    expect(shouldShowInInbox(probe as any)).toBe(false);
    expect(shouldShowInInbox({ ...probe, project_path: "/home/u/src/app" } as any)).toBe(true);
  });
});
