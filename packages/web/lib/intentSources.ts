// Where a source opens (initiatives-projects-role-page.md I5): the one
// reading of an IntentSource as an in-app route, since routes are the web's.
// The shared contract reads and labels a source; this only answers "where".
import { entityRoute } from "./entityLinks";
import { chatHref } from "./chatHref";
import type { IntentSource } from "@codecast/shared/contracts/initiative";

/** The route a source opens, or null for a note, a chat message with no channel, or a ref nothing answers to. */
export function intentSourceHref(s: IntentSource): string | null {
  const ref = (s.ref ?? "").trim();
  if (!ref) return null;
  switch (s.kind) {
    case "link": return ref;
    case "call": return entityRoute("call", ref);
    case "session": return entityRoute("session", ref.split(":")[0]);
    case "task": return entityRoute("task", ref);
    case "plan": return entityRoute("plan", ref);
    case "doc": return entityRoute("doc", ref);
    // A chat message address is "<channel>/<message>" or "<channel>"; a bare
    // message id has nowhere to open and shows as text.
    case "chat": { const [channel, message] = ref.split("/"); return ref.includes("/") ? chatHref(channel, message) : null; }
    default: return null;
  }
}
