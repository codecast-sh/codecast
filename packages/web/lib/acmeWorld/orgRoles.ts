// The Webhooks lead as its role page shows it: the org tree of ./extras with
// the role's charter, its reporting line to Sarah Chen, its Webhooks area and
// its standing conversation (a recent exchange about the retry queue). The
// tree answer here wraps ORG_TREE rather than copying it, so the chart stays
// one fixture. Mobile's Metro reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { ORG_TREE } from "./extras";
import { DAY, MIN, PEOPLE, cid, session } from "./world";

export const WEBHOOKS_SEAT = { _id: cid("sseatwebhooks"), short_id: "jx7s3wl", title: "Webhooks lead", agent_type: "claude_code" } as const;

const CHARTER = `Own Acme's webhook delivery: every event a customer is sent arrives, or lands in the dead-letter queue with a reason.

- Keep the retry queue healthy: backoff, attempt caps, dead letters.
- Read the dead-letter queue every week and retry what failed on a 5xx.
- Bring Sarah anything that changes what a customer sees.`;

const SEAT_TRANSCRIPT = (now: number) => {
  const t = (mins: number) => now - mins * MIN;
  return [
    { _id: "hero-seat-m1", role: "user", content: "Where are we on webhook retries? Support wants to know if last night's 502s were caught.", timestamp: t(42) },
    {
      _id: "hero-seat-m2",
      role: "assistant",
      content:
        "All 14 deliveries that hit the ledger's 502s overnight were retried and landed, 12 on the second attempt and 2 on the third. Nothing reached the dead-letter queue.\n\nOpen now: the queue worker (ct-4182) is in progress in the lead session, and Maya's dashboard history (ct-4188) is wiring its Retry button. PR #482 is approved and green.",
      timestamp: t(40),
    },
    { _id: "hero-seat-m3", role: "user", content: "Good. Should a 410 Gone count as a failure?", timestamp: t(12) },
    {
      _id: "hero-seat-m4",
      role: "assistant",
      content: "No. A 410 means the endpoint is gone, so a retry can never land. I logged it as final in the plan and asked the API session to stop retrying it; the change is in review on #482.",
      timestamp: t(10),
    },
  ];
};

const withSeat = (tree: ReturnType<typeof ORG_TREE>, now: number) => ({
  ...tree,
  roles: tree.roles.map((r: any) =>
    r.handle !== "webhooks"
      ? r
      : {
          ...r,
          charter: CHARTER,
          reports_to: { kind: "user" as const, user_id: PEOPLE.sarah._id },
          host_user_id: PEOPLE.me._id,
          trust: "decide",
          scope_names: { projects: [{ id: cid("projwebhooks"), title: "Webhooks", short_id: "pj-12" }], plans: [{ id: cid("planwebhooks"), title: "Webhook retries", short_id: "pl-312" }] },
          standing: { ...r.standing, conversation_id: WEBHOOKS_SEAT._id, short_id: WEBHOOKS_SEAT.short_id },
          created_at: now - 12 * DAY,
        },
  ),
});

export const ORG_ROLES_PART: AcmePart = {
  name: "orgRoles",
  sessions: (now) => [
    session(now, WEBHOOKS_SEAT, {
      ago: 10 * MIN,
      waiting: "done",
      project: "~/src/billing",
      messages: 4,
      state: "Overnight 502s all retried and landed\nStatus: 410s are final, change in review",
      extra: { org_role_id: cid("rolewebhooks"), inbox_dismissed_at: now - 5 * MIN },
    }),
  ],
  seed: (s, now) => s.applyTailMessages(WEBHOOKS_SEAT._id, 0, SEAT_TRANSCRIPT(now) as any, null),
  answers: {
    "org:tree": () => withSeat(ORG_TREE(Date.now()), Date.now()),
  },
};
