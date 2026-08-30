import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/convex/_generated/api.js";
import { cleanNotificationBody } from "../lib/notificationText";
import type { ShareKind } from "@codecast/shared/entities";

/**
 * The server's view of shared objects: one Convex client, one query per share
 * kind, one TTL cache in front. Both consumers ride the same cache — a bot
 * unfurl warms the exact payload the human click that follows will inline —
 * and both stay protected from repeat loads of a hot link.
 *
 * A null QUERY RESULT is cached (unknown token — stable for the TTL); a FAILED
 * query is not cached and returns null, so callers can fall back and retry.
 */

const convexUrl = process.env.VITE_CONVEX_URL || "https://convex.codecast.sh";
export const convex = new ConvexHttpClient(convexUrl);

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
  const path = kind === "conversation" ? `/share/${token}` : `/share/${kind}/${token}`;
  const url = `${baseUrl}${path}`;

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
  }
}
