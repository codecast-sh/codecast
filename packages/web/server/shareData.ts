import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/convex/_generated/api.js";
import { cleanNotificationBody } from "../lib/notificationText";
import { sharePath, type ShareKind } from "@codecast/shared/entities";
import { CONVEX_URL } from "./convexUrl";
import { GUEST_LINK_REFUSAL_TEXT, guestJoinPath, guestNoticeSentence, type GuestLinkRefusal } from "@codecast/shared/contracts";
import { meetingTitle } from "../lib/calls/roomGuests";

/**
 * The server's view of shared objects: one Convex client, one query per share
 * kind, one TTL cache in front. Both consumers ride the same cache — a bot
 * unfurl warms the exact payload the human click that follows will inline —
 * and both stay protected from repeat loads of a hot link.
 *
 * A null QUERY RESULT is cached (unknown token — stable for the TTL); a FAILED
 * query is not cached and returns null, so callers can fall back and retry.
 */

export const convex = new ConvexHttpClient(CONVEX_URL);

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; value: unknown }>();

export async function cachedQuery(
  key: string,
  fetch: () => Promise<unknown>,
): Promise<{ value: unknown } | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { value: hit.value };
  try {
    const value = await fetch();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > MAX_ENTRIES) {
      for (const k of cache.keys()) {
        if (cache.size <= MAX_ENTRIES) break;
        cache.delete(k);
      }
    }
    return { value };
  } catch {
    return null;
  }
}

const SHARE_QUERIES: Record<ShareKind, (token: string) => Promise<unknown>> = {
  conversation: (t) => convex.query(api.conversations.getSharedConversationMeta, { share_token: t }),
  message: (t) => convex.query(api.messages.getSharedMessage, { share_token: t }),
  doc: (t) => convex.query((api as any).docs.getShared, { share_token: t }),
  plan: (t) => convex.query((api as any).plans.getShared, { share_token: t }),
  task: (t) => convex.query(api.publicShare.getSharedTask, { share_token: t }),
  call: (t) => convex.query(api.publicShare.getSharedCall, { share_token: t }),
  project: (t) => convex.query(api.publicShare.getSharedProject, { share_token: t }),
  initiative: (t) => convex.query(api.publicShare.getSharedInitiative, { share_token: t }),
  decision: (t) => convex.query(api.publicShare.getSharedDecision, { share_token: t }),
  stack: (t) => convex.query(api.publicShare.getSharedStack, { share_token: t }),
  trigger: (t) => convex.query(api.publicShare.getSharedTrigger, { share_token: t }),
  run: (t) => convex.query(api.publicShare.getSharedRun, { share_token: t }),
};

/** The shared object behind a token, through the cache. `null` = query failed;
 * `{ value: null }` = the token resolved to nothing. */
export function fetchShared(kind: ShareKind, token: string): Promise<{ value: unknown } | null> {
  return cachedQuery(`${kind}:${token}`, () => SHARE_QUERIES[kind](token));
}

// --- Unfurl meta -------------------------------------------------------------
// Pure: query payload in, link-card text out. Descriptions flatten to one
// clean line because unfurl cards render no markdown.

export interface ShareMeta {
  title: string;
  description: string;
  url: string;
  type?: string;
}

export function shareMeta(
  kind: ShareKind,
  token: string,
  data: unknown,
  baseUrl: string,
): ShareMeta | null {
  if (!data || typeof data !== "object") return null;
  const d = data as any;
  const url = `${baseUrl}${sharePath(kind, token)}`;

  switch (kind) {
    case "conversation": {
      const title = d.title || "Shared Conversation";
      const description = d.description
        || (d.author ? `${d.message_count} messages by ${d.author}` : `${d.message_count} messages`);
      return { title: `Codecast: ${title}`, description, url, type: "article" };
    }
    case "message": {
      const title = d.conversation?.title || "Shared Message";
      const description = d.note
        || cleanNotificationBody(d.message?.content || "", 200)
        || `Shared ${d.message?.role === "user" ? "prompt" : "response"}${d.user?.name ? ` from ${d.user.name}` : ""}`;
      return { title: `Codecast: ${title}`, description, url, type: "article" };
    }
    case "doc": {
      const title = d.title || "Shared Document";
      const description = cleanNotificationBody(d.content || "", 200)
        || (d.user?.name ? `A ${d.doc_type || "document"} shared by ${d.user.name}` : "A shared document");
      return { title: `Codecast: ${title}`, description, url, type: "article" };
    }
    case "plan": {
      const title = d.title || "Shared Plan";
      const tasks: Array<{ status?: string }> = Array.isArray(d.tasks) ? d.tasks : [];
      const done = tasks.filter((t) => t.status === "done").length;
      const description = cleanNotificationBody(d.goal || "", 200)
        || (tasks.length ? `${done}/${tasks.length} tasks done` : "A shared plan");
      return { title: `Codecast: ${title}`, description, url, type: "article" };
    }
    case "task": {
      const title = d.title || "Shared Task";
      const description = cleanNotificationBody(d.description || "", 200)
        || `${d.short_id ? `${d.short_id}, ` : ""}${String(d.status || "open").replace("_", " ")}`;
      return { title: `Codecast: ${title}`, description, url, type: "article" };
    }
    case "call": {
      const title = d.title || (d.recording ? "Shared Recording" : "Shared Huddle");
      const names: string[] = Array.isArray(d.participants) ? d.participants.map((p: any) => p.name).filter(Boolean) : [];
      const description = cleanNotificationBody(d.summary || "", 200)
        || (names.length ? `A call with ${names.join(", ")}` : "A shared call");
      return { title: `Codecast: ${title}`, description, url, type: "article" };
    }
    case "project":
    case "initiative": {
      const title = d.title || `Shared ${kind}`;
      const description = cleanNotificationBody(d.goal || d.description || "", 200) || `A ${kind} on Codecast`;
      return { title: `Codecast: ${title}`, description, url, type: "article" };
    }
    case "decision": {
      const options: string[] = Array.isArray(d.options) ? d.options.map((o: any) => o.label) : [];
      const chosen = d.status === "answered" && d.answer_index != null ? options[d.answer_index] : null;
      const description = chosen ? `Decided: ${chosen}` : options.length ? `Options: ${options.join(", ")}` : "A decision on Codecast";
      return { title: `Codecast: ${d.question || "Shared decision"}`, description: cleanNotificationBody(description, 200), url, type: "article" };
    }
    case "stack": {
      const ds: any[] = Array.isArray(d.decisions) ? d.decisions : [];
      const decided = ds.filter((x) => x.status === "answered").length;
      return { title: `Codecast: ${d.title || "Shared decisions"}`, description: `${decided} of ${ds.length} decisions made`, url, type: "article" };
    }
    case "trigger": {
      const description = cleanNotificationBody(d.summary || d.prompt || "", 200) || "A standing instruction to an agent";
      return { title: `Codecast: ${d.title || "Shared trigger"}`, description, url, type: "article" };
    }
    case "run": {
      const nodes: any[] = Array.isArray(d.nodes) ? d.nodes : [];
      const done = nodes.filter((n) => n.status === "completed").length;
      const description = cleanNotificationBody(d.goal || "", 200) || `${done} of ${nodes.length} steps done`;
      return { title: `Codecast: ${d.name || "Workflow run"}`, description, url, type: "article" };
    }
  }
}

// --- Guest meeting links ------------------------------------------------------
// /meet/<token> is not a share kind (it opens a door into a live call, not a
// read-only object), but it travels the same way: pasted into a chat or a
// calendar invite, where the card is the first thing the guest reads.

/** callGuests.describeGuestLink for a token, through the same cache. */
export function fetchGuestLink(token: string): Promise<{ value: unknown } | null> {
  return cachedQuery(`meet:${token}`, () => convex.query(api.callGuests.describeGuestLink, { token }));
}

/** The link card for a guest link: which meeting, who is asking, and the
 *  notice, because a card is the first place a guest can be told. A closed
 *  link says so rather than inviting anybody anywhere. */
export function guestMeetMeta(token: string, data: unknown, baseUrl: string): ShareMeta | null {
  if (!data || typeof data !== "object") return null;
  const d = data as any;
  const url = `${baseUrl}${guestJoinPath(token)}`;
  if (!d.ok) {
    const reason = (d.reason ?? "not_found") as GuestLinkRefusal;
    return { title: "codecast: this meeting link is closed", description: GUEST_LINK_REFUSAL_TEXT[reason] ?? GUEST_LINK_REFUSAL_TEXT.not_found, url };
  }
  const title = meetingTitle(d.title, d.inviter);
  const notice = guestNoticeSentence({ recording: !!d.recording, transcribed: !!d.transcribed });
  const kept = notice ? ` ${notice}` : "";
  const who = d.inviter?.name ? `${d.inviter.name} invited you to join.` : "You are invited to join.";
  return {
    title: `Join: ${title}`,
    description: `${who} Join from your browser, no account needed.${kept}`,
    url,
  };
}
