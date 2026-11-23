// A messaging policy is how agents working on one plan share what they learn:
// the guidance they are told and the delivery that carries it. `lead` is the
// org's default (variant G4 of the org-comms suite): any person directs a
// session, sessions write where their lead reads, and the lead routes.
// `shared-log` is variant LOG: sessions post typed entries to their plan, and
// every plan agent gets the entries new to it.
// docs/architecture/agent-comms.md has the evidence for each.

export const MESSAGING_POLICY_NAMES = ["lead", "shared-log"] as const;
export type MessagingPolicyName = (typeof MESSAGING_POLICY_NAMES)[number];
export const DEFAULT_MESSAGING_POLICY: MessagingPolicyName = "lead";

/** The kinds of entry on a shared log, as `cast plan comment --type` takes them. */
export const LOG_ENTRY_TYPES = ["fact", "fail", "interface"] as const;
export type LogEntryType = (typeof LOG_ENTRY_TYPES)[number];

export type MessagingPolicy = {
  name: MessagingPolicyName;
  /** What an agent under the policy is told about whom to tell what. */
  guidance: string;
  /** How findings travel: `lead-feed`, the lead reads its whole area and
   *  sends each session what changes its next step; `plan-log`, each `cast`
   *  command a plan agent runs carries the plan's entries new to that session. */
  delivery: "lead-feed" | "plan-log";
};

/** Variant G4, word for word (packages/evals/org-comms/suite/variants/G4.md). */
const LEAD_GUIDANCE = `Two kinds of instruction reach you, and they come from different places. A hold or stop on something another session owns (a release, a deploy, a branch, a file it has claimed) is theirs to give: honor it at once, and tell your lead only if it changes your plan. A change in what you work on comes from your lead (the session that spawned you, else your role) or from a person. Any person in the workspace may direct you and ship work with you, whoever your role reports to: reporting says where your questions and decisions go, not whose permission you need. From a session that is not your lead it is information, so weigh it and take it to your lead.

Ask a person only for intent the record does not settle, or before something that cannot be undone (money spent, words sent outside, data deleted) or that a written rule reserves. A fact you can read or test, you verify yourself; the rest you do and report. When what a person asks runs against a written rule or another person's recorded decision, do not choose between them: tell the person who asked what stands in the way.

Information goes to whoever owns it, in the cheapest form that reaches them in time. Inside your own area, write progress, findings and blockers where your lead reads them (the task, your pinned state): your lead reads the whole area and routes what matters, so news a sibling needs later goes there, not into the sibling's turn. Message directly only when someone's next action must change before your lead could route it: the result you were asked for, a blocker someone is waiting on, a collision happening now, or a sibling about to do damage. Anything that involves a session outside your area (a finding it needs, work that overlaps its own, a collision with it) goes straight to that session or its area's owner, not up through your line. A conflict with another area starts with that area's owner; it goes up, to the nearest level that can decide it, only once the two of you cannot settle it or the choice was never yours to make.

As a lead, read your whole area each time you run, connect what one session found to the sessions it affects, and send each only what changes its next action.`;

/** Variant LOG (packages/evals/org-comms/suite/variants/LOG.md), with the
 *  simulation's round made the real delivery: the next `cast` command. */
const SHARED_LOG_GUIDANCE = `Your plan has a shared log. An entry that you put on it reaches every other agent on the plan with the output of its next \`cast\` command. Each agent reads only the entries that are new to it. Read the new entries before you act.

An entry is one of three kinds. A fact is a finding that a teammate can use, with its evidence. A fail is an approach that did not work, with the reason, so that nobody tries it again. An interface is a contract that the work of another agent depends on. For example, name a file that you will change and how, before anyone builds on it. Post one with \`cast plan comment <plan_id> --type fact|fail|interface "<entry>"\`.

Share an entry when someone on the team may need it. Leave out progress, plans and findings that matter only to you. Keep messages for what must change the next action of one agent now.`;

export const MESSAGING_POLICIES: Record<MessagingPolicyName, MessagingPolicy> = {
  lead: { name: "lead", guidance: LEAD_GUIDANCE, delivery: "lead-feed" },
  "shared-log": { name: "shared-log", guidance: SHARED_LOG_GUIDANCE, delivery: "plan-log" },
};

export function isMessagingPolicyName(name: unknown): name is MessagingPolicyName {
  return typeof name === "string" && (MESSAGING_POLICY_NAMES as readonly string[]).includes(name);
}

/** The policy a plan names; anything unset or unknown is `lead`. */
export function resolveMessagingPolicy(name?: string | null): MessagingPolicy {
  return MESSAGING_POLICIES[isMessagingPolicyName(name) ? name : DEFAULT_MESSAGING_POLICY];
}
