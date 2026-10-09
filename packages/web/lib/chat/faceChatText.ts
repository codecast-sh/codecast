import { useInboxStore } from "../../store/inboxStore";

// Words for chat from the face (components/faces/FaceChatLayer, FaceMessages):
// where a line was said, and whether an @ in it names the viewer.

export function whereOf(channelId: string, isDm: boolean, threadRootId?: string): string {
  if (isDm) return threadRootId ? "thread · direct message" : "direct message";
  const name = (useInboxStore.getState() as any).chatChannels?.[channelId]?.name;
  return `${threadRootId ? "thread in " : "in "}#${name ?? "channel"}`;
}

/** The handles a line could name the viewer by: their GitHub login, their
 *  name, its first word, and the room-wide ones. Lowercase, without the @. */
export function viewerHandles(): Set<string> {
  const u: any = useInboxStore.getState().currentUser;
  const out = new Set<string>(["here", "channel", "everyone"]);
  for (const h of [u?.github_username, u?.name, String(u?.name ?? "").split(/\s+/)[0]]) if (h) out.add(String(h).toLowerCase());
  return out;
}

export function timeAgo(at: number, now = Date.now()): string {
  const s = (now - at) / 1000;
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
