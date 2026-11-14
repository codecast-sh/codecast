// The Head of People's open proposal for Acme's org (org-staffing.md S4): a
// Webhooks lead reporting to Sarah Chen, the lead's area widened to the
// dashboard work, and a weekly dead-letter check. Answered to the proposal
// feeds (orgProposals.list, orgProposals.get), whose feeders write the store.
// The org tree it sits on is ./extras ORG_TREE. Mobile's Metro reaches this
// file, so imports stay relative.

import type { AcmePart } from "./parts";
import { MIN, TEAM_ID, cid } from "./world";

export const PROPOSAL = { _id: cid("propwebhooks"), short_id: "op-41" };

const AUTHOR = { kind: "role" as const, id: cid("rolepeople"), name: "Head of People", handle: "head-of-people", short_id: "rl-people" };

const row = (now: number) => ({
  _id: PROPOSAL._id,
  short_id: PROPOSAL.short_id,
  team_id: TEAM_ID,
  author: AUTHOR,
  title: "Give webhooks one owner",
  summary_md: "Webhook work is spread across three sessions and nobody owns the retry queue between them. One lead under Sarah would hold it, with a weekly check on the dead letters.",
  mode: "review",
  status: "open",
  created_at: now - 20 * MIN,
});

const change = (seq: number, c: Record<string, unknown>, rationale: string) => ({
  _id: cid(`propwebhooksc${seq}`),
  proposal_id: PROPOSAL._id,
  seq,
  change: c,
  rationale,
  evidence: [],
  status: "proposed",
});

const CHANGES = [
  change(1, { kind: "role", name: "Webhooks lead", handle: "webhooks", reports_to: "Sarah Chen", scope: { projects: ["Webhooks"] } }, "Three sessions touched the retry queue this week and none of them owned it."),
  change(2, { kind: "scope", handle: "webhooks", add: ["Dashboard"] }, "The retry history in the dashboard ships with the queue; one owner keeps them in step."),
  change(3, { kind: "routine", handle: "webhooks", title: "Weekly dead-letter check", prompt: "Read the webhook dead-letter queue, name the endpoints that landed there and why, and retry the 5xx ones.", every: "1w" }, "Dead letters are where a dropped event hides; someone should read them every week."),
];

export const ORG_PROPOSALS_PART: AcmePart = {
  name: "orgProposals",
  answers: {
    "orgProposals:list": () => ({ proposals: [row(Date.now())] }),
    "orgProposals:get": (a) => (a?.proposal === PROPOSAL.short_id || a?.proposal === PROPOSAL._id ? { ...row(Date.now()), changes: CHANGES } : null),
  },
};
