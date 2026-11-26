import { useInboxStore } from "../store/inboxStore";
import { sessionColor, sessionShortTitle } from "../lib/code/agent/sessions";

/** The fields a mark draws, as one comparable string. */
export function useSessionFace(id: string | null | undefined): { title: string; agent: string; color: string } | null {
  const sig = useInboxStore((s) => {
    const r = id ? s.sessions[id] : undefined;
    return r ? `${r.agent_type}\u0000${r.short_title ?? ""}\u0000${r.title ?? ""}\u0000${r.icon_color ?? ""}` : "";
  });
  if (!id || !sig) return null;
  const [agent, short_title, title, icon_color] = sig.split("\u0000");
  return { agent, title: sessionShortTitle({ short_title, title }), color: sessionColor({ _id: id, icon_color: icon_color || undefined }) };
}
