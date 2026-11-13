// The server tiers of search (conversations.searchConversations and
// searchConversationTitles), as the /search page, the Cmd-K palette and the
// phone's search ask them: sessions across the team whose title or messages
// hold every word of the query, each with the messages that matched. Mobile's
// Metro reaches this file, so imports stay relative.

import type { AcmePart } from "./parts";
import { MIN, PEOPLE, SESSIONS, TEAM_ID, type Person } from "./world";
import { TEAM_SESSIONS as T } from "./teamSessions";

type Hit = { s: { _id: string; title: string; agent_type: string }; who: Person; ago: number; project: string; msgs: number; workers?: number; lines: { role: "user" | "assistant"; text: string }[] };

const HITS: Hit[] = [
  {
    s: SESSIONS.lead, who: PEOPLE.me, ago: 0, project: "~/src/billing", msgs: 64, workers: 2,
    lines: [
      { role: "user", text: "Failed Stripe webhooks should retry instead of dropping. Split the API and the dashboard across workers." },
      { role: "assistant", text: "The retry queue is in. A failed webhook delivery now waits 2s, 4s, 8s, 16s with jitter and stops after the fifth retry." },
    ],
  },
  {
    s: T.backoff, who: PEOPLE.maya, ago: T.backoff.ago, project: T.backoff.project, msgs: T.backoff.messages,
    lines: [
      { role: "assistant", text: "Exponential backoff with jitter recovers 96% of failed webhook deliveries by the fifth retry; a fixed 5s retry recovers 71%." },
      { role: "user", text: "Go with exponential and cap it at 5 attempts. Write the webhook retry schedule into the spec." },
    ],
  },
  {
    s: T.replay, who: PEOPLE.sarah, ago: T.replay.ago, project: T.replay.project, msgs: T.replay.messages,
    lines: [{ role: "assistant", text: "Replayed 212 webhook events from the Stripe export; 3 failed again and went back to the retry queue." }],
  },
  {
    s: SESSIONS.api, who: PEOPLE.me, ago: MIN, project: "~/src/billing", msgs: 12,
    lines: [{ role: "assistant", text: "POST /v2/hooks/retry is in: an idempotent webhook retry, 5 attempts max, reusing deliver() for each one." }],
  },
  {
    s: T.dlq, who: PEOPLE.maya, ago: T.dlq.ago, project: T.dlq.project, msgs: T.dlq.messages,
    lines: [{ role: "assistant", text: "A webhook that fails its last retry lands in the dead-letter queue with its final response body." }],
  },
  {
    s: T.sigrot, who: PEOPLE.maya, ago: T.sigrot.ago, project: T.sigrot.project, msgs: T.sigrot.messages,
    lines: [{ role: "assistant", text: "Rotating the webhook signing secret keeps the old one valid for 24 hours so in-flight events still verify." }],
  },
  {
    s: SESSIONS.ui, who: PEOPLE.me, ago: 40_000, project: "~/src/billing", msgs: 18,
    lines: [{ role: "assistant", text: "Each failed webhook row gets a Retry button and its attempt history." }],
  },
];

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const holds = (text: string, ws: string[]) => ws.every((w) => text.toLowerCase().includes(w));

function search(args: any, titlesOnly = false) {
  const ws = words(String(args?.query ?? args?.q ?? ""));
  const now = Date.now();
  const results = ws.join("").length < 2 ? [] : HITS.flatMap((h, i) => {
    const titleMatch = holds(h.s.title, ws);
    const matched = titlesOnly ? [] : h.lines.filter((l) => holds(l.text, ws));
    if (!titleMatch && matched.length === 0) return [];
    if (titlesOnly && !titleMatch) return [];
    return [{
      conversationId: h.s._id,
      title: h.s.title,
      matchCount: matched.length,
      matches: matched.map((l, j) => ({ messageId: `${h.s._id}-hit${j}`, content: l.text, role: l.role, timestamp: now - h.ago - (j + 1) * 3 * MIN })),
      updatedAt: now - h.ago,
      authorName: h.who.name,
      authorAvatar: h.who.image,
      isOwn: h.who._id === PEOPLE.me._id,
      messageCount: h.msgs,
      relevance: 10 - i,
      workerCount: h.workers ?? 0,
      titleMatch,
      projectPath: h.project,
      agentType: h.s.agent_type,
      workspace: `team:${TEAM_ID}`,
    }];
  });
  return { results, totalMatches: results.reduce((n, r) => n + r.matchCount, 0), totalSessions: results.length };
}

export const SEARCH_PART: AcmePart = {
  name: "search",
  answers: {
    "conversations:searchConversations": (a) => search(a),
    "conversations:searchConversationTitles": (a) => search(a, true),
  },
};
