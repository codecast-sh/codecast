// The share control every object page carries in its header: one icon, one
// popover (SharePopover) with the object's page link, send to chat, and, for
// every kind with a public view, who can open the link. Conversations add team levels on top of the same popover
// (ConversationSharePopover).
import { sharePath } from "@codecast/shared/entities";
import { useInboxStore, type PublicShareKind } from "../store/inboxStore";
import { shareOrigin, sharePageUrl } from "../lib/utils";
import { SharePopover } from "./SharePopover";

export interface PublicShare {
  kind: PublicShareKind;
  /** The object's Convex id. */
  id: string;
  /** Its current share token; absent while nobody can open it without access. */
  token: string | null | undefined;
}

export function ShareControl({
  label,
  path,
  publicShare,
  className,
}: {
  /** What the object is, for the popover title and the chat picker ("task"). */
  label: string;
  /** The object's canonical in-app path (never the address bar: a pane can
   *  host the object under another route). */
  path: string;
  /** Present when the viewer may open the object to anyone. */
  publicShare?: PublicShare;
  /** Placement in the host header (e.g. "ml-auto"). */
  className?: string;
}) {
  const setObjectShareLink = useInboxStore((s) => s.setObjectShareLink);
  const token = publicShare?.token ?? null;
  const publicUrl = (t: string) => `${shareOrigin()}${sharePath(publicShare!.kind, t)}`;
  const control = (
    <SharePopover
      canManage={!!publicShare}
      hasTeam={false}
      hasShareToken={!!token}
      shareUrl={token ? publicUrl(token) : null}
      pageUrl={sharePageUrl(path)}
      forwardLabel={label}
      onGenerateShareLink={async () => {
        const next = token ?? crypto.randomUUID();
        setObjectShareLink(publicShare!.kind, publicShare!.id, next);
        return publicUrl(next);
      }}
      onRevokeShareLink={async () => setObjectShareLink(publicShare!.kind, publicShare!.id, null)}
    />
  );
  return className ? <span className={`inline-flex ${className}`}>{control}</span> : control;
}
