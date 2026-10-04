import { SOL } from "../../blog/blogChrome";

/**
 * One illustrative huddle, used by every mock on the page so the hero, the
 * digest, the citations and the tasks all tell the same story. The people
 * and numbers are made up; the shapes (cl-42:N references, the digest
 * fields, the task flags) are the real ones.
 */
export const CALL_ID = "cl-42";
export const CALL_TITLE = "Webhook retry rollout";
export const CALL_LENGTH = "6m";

export type Speaker = { id: string; name: string; initials: string; color: string };

export const PEOPLE: Speaker[] = [
  { id: "maya", name: "Maya", initials: "M", color: SOL.blue },
  { id: "theo", name: "Theo", initials: "T", color: SOL.green },
  { id: "priya", name: "Priya", initials: "P", color: SOL.violet },
];

export const AGENT = { name: "Webhook retries", backend: "claude", color: SOL.magenta };

export type Line = { seq: number; speaker: string; at: string; text: string; /** start and end as a fraction of the hero timeline */ from: number; to: number };

export const LINES: Line[] = [
  { seq: 1, speaker: "maya", at: "0:04", text: "Retries are failing on the Stripe webhook again. About one in fifty.", from: 0.02, to: 0.16 },
  { seq: 2, speaker: "theo", at: "0:11", text: "That's the backoff. We stop after three tries and Stripe sends bursts.", from: 0.18, to: 0.33 },
  { seq: 3, speaker: "priya", at: "0:19", text: "Can we move to exponential with jitter before Friday?", from: 0.35, to: 0.45 },
  { seq: 4, speaker: "theo", at: "0:24", text: "Yes, I'll take it. I'll add a dead letter queue while I'm in there.", from: 0.47, to: 0.6 },
  { seq: 5, speaker: "maya", at: "0:33", text: "Can the session count how many events we dropped this week?", from: 0.62, to: 0.74 },
  { seq: 6, speaker: "priya", at: "0:47", text: "Then I'll write the customer note once we have that list.", from: 0.84, to: 0.97 },
];

/** Where the room went quiet and the fed session received the words so far. */
export const AGENT_BATCHES = [0.335, 0.605, 0.755];

export const AGENT_REPLY = "312 events hit the retry cap since Monday and 41 never went through. The list is in the session.";

export const SUMMARY =
  "Stripe webhook retries give up after three tries, and bursts push about one in fifty events past that. The team agreed to move to exponential backoff with jitter before Friday and to tell affected customers once the dropped events are listed.";

export const ACTION_ITEMS = [
  { text: "Theo: exponential backoff with jitter and a dead letter queue for webhook retries, before Friday", owner: "theo", line: 4, task: "ct-812", title: "Exponential backoff with jitter for webhook retries" },
  { text: "Priya: customer note on dropped webhook events, once the list is ready", owner: "priya", line: 6, task: "ct-813", title: "Customer note on dropped webhook events" },
];

export function speakerOf(id: string): Speaker {
  return PEOPLE.find((p) => p.id === id) ?? PEOPLE[0];
}

export function lineAt(seq: number): Line {
  return LINES.find((l) => l.seq === seq) ?? LINES[0];
}
