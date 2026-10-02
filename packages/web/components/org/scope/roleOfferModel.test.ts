// The Head of People's offer as one state (org-staffing.md S24): what the row
// above its composer shows for a trigger, a seat and a workspace's proposals.
// Run: bun test components/org/scope/roleOfferModel.test.ts
import { describe, expect, test } from "bun:test";
import { COMPANY_REVIEW_TITLE } from "@codecast/shared/contracts/orgReview";
import { REVIEW_WINDOW_MS, companyReviewOf, deriveRoleOffer, offerTriggerOf, type RoleOfferInput, type RoleOfferProposal, type RoleOfferTrigger } from "./roleOfferModel";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const trigger = (over: Partial<RoleOfferTrigger> = {}): RoleOfferTrigger => ({ id: "t1", short_id: "tr-12", status: "scheduled", run_at: NOW + 5 * 86_400_000, last_run_at: NOW - 2 * 86_400_000, requested: false, focus: null, ...over });
const proposal = (over: Partial<RoleOfferProposal> = {}): RoleOfferProposal => ({ _id: "p1", short_id: "op-4", title: "Company review: Acme", status: "open", created_at: NOW - 86_400_000, ...over });
const input = (over: Partial<RoleOfferInput> = {}): RoleOfferInput => ({ trigger: trigger(), working: false, proposals: [], now: NOW, ...over });

describe("deriveRoleOffer", () => {
  test("offers nothing without a live Company review, and says so when it is paused", () => {
    expect(deriveRoleOffer(input({ trigger: null })).kind).toBe("none");
    expect(deriveRoleOffer(input({ trigger: trigger({ status: "cancelled" }) })).kind).toBe("none");
    expect(deriveRoleOffer(input({ trigger: trigger({ status: "paused" }) })).kind).toBe("paused");
  });

  test("offers to set the org up until a proposal has ever been made, then to review it", () => {
    expect(deriveRoleOffer(input())).toMatchObject({ kind: "offer", setUp: true, open: null });
    expect(deriveRoleOffer(input({ proposals: [proposal({ status: "resolved" })] }))).toMatchObject({ kind: "offer", setUp: false, open: null });
  });

  test("names the newest open proposal while one waits", () => {
    const older = proposal({ _id: "p0", short_id: "op-3", created_at: NOW - 3 * 86_400_000 });
    const offer = deriveRoleOffer(input({ proposals: [older, proposal(), proposal({ _id: "p2", short_id: "op-5", status: "withdrawn", created_at: NOW - 1 })] }));
    expect(offer).toMatchObject({ kind: "offer", setUp: false, open: { short_id: "op-4" } });
  });

  test("a run asked for and not yet delivered is starting, with its focus, whatever else is true", () => {
    const asked = trigger({ requested: true, run_at: NOW - 5_000, focus: "goal_tree" });
    expect(deriveRoleOffer(input({ trigger: asked, working: true, proposals: [proposal()] }))).toMatchObject({ kind: "starting", since: NOW - 5_000, focus: { label: "Plan the goal tree", running: "Planning the goal tree" } });
    expect(deriveRoleOffer(input({ trigger: trigger({ status: "running" }) })).kind).toBe("starting");
    // The request stamp may outlive the run on the client (a field lock); a
    // run delivered since the request ends the wait.
    expect(deriveRoleOffer(input({ trigger: trigger({ requested: true, run_at: NOW - 60_000, last_run_at: NOW - 30_000 }) })).kind).toBe("offer");
  });

  test("a delivered run reads as reviewing while the seat works on it, and ends when a proposal lands or the seat rests", () => {
    const delivered = trigger({ last_run_at: NOW - 4 * MIN });
    expect(deriveRoleOffer(input({ trigger: delivered, working: true }))).toMatchObject({ kind: "reviewing", since: NOW - 4 * MIN });
    expect(deriveRoleOffer(input({ trigger: delivered, working: false })).kind).toBe("offer");
    const landed = proposal({ created_at: NOW - MIN });
    expect(deriveRoleOffer(input({ trigger: delivered, working: true, proposals: [landed] }))).toMatchObject({ kind: "offer", open: { short_id: "op-4" } });
    // An older proposal does not end a newer run.
    expect(deriveRoleOffer(input({ trigger: delivered, working: true, proposals: [proposal()] })).kind).toBe("reviewing");
    // Work long after the run is not the review.
    expect(deriveRoleOffer(input({ trigger: trigger({ last_run_at: NOW - REVIEW_WINDOW_MS - 1 }), working: true })).kind).toBe("offer");
  });
});

describe("the trigger the offer reads", () => {
  test("is the Company review among the seat's triggers, a live one first", () => {
    const rows = [
      { _id: "a", title: "A session under you needs input", status: "scheduled" },
      { _id: "b", title: COMPANY_REVIEW_TITLE, status: "cancelled" },
      { _id: "c", title: COMPANY_REVIEW_TITLE, status: "paused" },
      { _id: "d", title: COMPANY_REVIEW_TITLE, status: "scheduled", short_id: "tr-9", run_at: 5, requested_run_source: "manual", requested_run_focus: "goal_tree" },
    ];
    expect(companyReviewOf(rows)._id).toBe("d");
    expect(companyReviewOf(rows.slice(0, 3))._id).toBe("c");
    expect(companyReviewOf(rows.slice(0, 1))).toBeNull();
    expect(offerTriggerOf(companyReviewOf(rows))).toEqual({ id: "d", short_id: "tr-9", status: "scheduled", run_at: 5, last_run_at: null, requested: true, focus: "goal_tree" });
    expect(offerTriggerOf(null)).toBeNull();
  });
});
