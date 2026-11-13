// Acme's docs: the webhook retry policy spec with live mentions of the tasks
// it describes, plus the team's other docs for the list beside it. List rows
// go into the store's docs collection; the detail answers
// taskMining.webGetDocDetail. Maya has the spec open (docSync presence).
// Mobile's Metro reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { DAY, HOUR, MIN, PEOPLE, SESSIONS, TEAM_ID, WORKSPACE, cid } from "./world";

export const RETRY_SPEC_ID = cid("docretryspec");

const RETRY_SPEC = `Support saw two Stripe events dropped overnight. Both failed on a 502 from the ledger during its restart, and nothing tried them again. This page is the policy every webhook delivery follows from now on.

## When a delivery is retried

A delivery is retried when the endpoint answers 5xx or 429, or does not answer within 10 seconds. Anything else is final: a 2xx is delivered, a 4xx other than 429 is logged once and never retried.

- **410 Gone** is final. The endpoint is gone, so no retry can succeed.
- **429 Too Many Requests** honors \`Retry-After\` when the endpoint sends one.

## Schedule

| Attempt | Wait before it | Worst case so far |
| --- | --- | --- |
| 2 | 2s | 2s |
| 3 | 4s | 6s |
| 4 | 8s | 14s |
| 5 | 16s | 30s |

Each wait carries up to 20% jitter, so a burst of failures does not retry in lockstep. The queue is built in @[Retry queue for failed webhooks ct-4182].

## After the last attempt

An event that fails all 5 attempts lands in the dead-letter queue with its last response, and on-call is paged. See @[Dead-letter queue for poisoned events ct-4184] and @[Page on-call when retries run out ct-4185].

## Signing

Every attempt carries the same HMAC signature, so a receiver can verify a retry exactly as it verified the first delivery (@[Sign webhook payloads with HMAC ct-4183]).
`;

const doc = (now: number, d: { key: string; title: string; content: string; type: string; ago: number; pinned?: boolean; labels?: string[] }) => ({
  _id: d.key === "spec" ? RETRY_SPEC_ID : cid(`doc${d.key}`),
  title: d.title,
  content: d.content,
  doc_type: d.type,
  source: "human",
  team_id: TEAM_ID,
  workspace: WORKSPACE,
  labels: d.labels ?? [],
  pinned: d.pinned ?? false,
  created_at: now - d.ago - 2 * DAY,
  updated_at: now - d.ago,
});

export const DOCS = (now: number) => [
  doc(now, { key: "spec", title: "Webhook retry policy", content: RETRY_SPEC, type: "spec", ago: 12 * MIN, pinned: true, labels: ["webhooks"] }),
  doc(now, { key: "runbook", title: "Ledger restart runbook", content: "## Before the restart\n\nPause payouts and announce the window in #incidents.", type: "note", ago: 5 * HOUR, labels: ["ops"] }),
  doc(now, { key: "stripe", title: "Stripe SDK v14 migration notes", content: "## What changed\n\n38 call sites moved to the new client.", type: "note", ago: 26 * HOUR, labels: ["billing"] }),
  doc(now, { key: "support", title: "What support tells customers about retries", content: "## Short answer\n\nA failed webhook is retried up to 5 times over about 30 seconds.", type: "note", ago: 2 * DAY, labels: ["docs"] }),
  doc(now, { key: "audit", title: "Audit log export design", content: "## Goal\n\nOne manifest per day in S3.", type: "spec", ago: 3 * DAY, labels: ["infra"] }),
];

const DOC_DETAIL = (now: number, id: string) => {
  const d = DOCS(now).find((x) => x._id === id);
  if (!d) return null;
  if (id !== RETRY_SPEC_ID) return d;
  return { ...d, conversation: { _id: SESSIONS.lead._id, title: SESSIONS.lead.title, agent_type: SESSIONS.lead.agent_type }, related_tasks: [] };
};

export const DOCS_PART: AcmePart = {
  name: "docs",
  seed: (s, now) => s.syncTable("docs", DOCS(now)),
  answers: {
    "taskMining:webGetDocDetail": (a) => DOC_DETAIL(Date.now(), String(a?.id ?? "")),
    "docSync:getPresence": (a) =>
      a?.doc_id === RETRY_SPEC_ID
        ? [{ _id: cid("presmaya"), doc_id: RETRY_SPEC_ID, user_id: PEOPLE.maya._id, user_name: PEOPLE.maya.name, user_image: PEOPLE.maya.image, name: PEOPLE.maya.name, image: PEOPLE.maya.image, color: "#d33682", updated_at: Date.now() - 4_000 }]
        : [],
  },
};
