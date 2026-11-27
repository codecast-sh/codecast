// The share control every object page carries in its header: one icon, one
// popover (SharePopover) with the object's page link, send to chat, and, for
// every kind with a public view, who can open the link. Conversations add team levels on top of the same popover
// (ConversationSharePopover). A kind people refer to by its short id (pri-N)
// adds that id with Copy ID.
import { sharePath } from "@codecast/shared/entities";
import { useInboxStore, type PublicShareKind } from "../store/inboxStore";
import { shareOrigin, sharePageUrl } from "../lib/utils";
import { SharePopover } from "./SharePopover";
import { usePolicyRefusal } from "../lib/managedPolicy";
import { copyText } from "../lib/copyText";

export interface PublicShare {
  kind: PublicShareKind;
  /** The object's Convex id. */
  id: string;
  /** Its current share token; absent while nobody can open it without access. */
  token: string | null | undefined;
  /** Why this viewer may close the link but not open it (SharePopover
   *  openRefusal); absent when they may do both. */
  openRefusal?: string | null;
  /** The team whose policy governs the object (policyTeamOf): its admins may turn public links off. */
  team?: string | null;
}

export function ShareControl({
  label,
  path,
  publicShare,
  className,
  linkExtra,
  access,
  defaultOpen,
  copyId,
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
  /** What else the public link carries (SharePopover linkExtra). */
  linkExtra?: React.ReactNode;
  /** The object's own access section (SharePopover access): who can edit it. */
  access?: React.ReactNode;
  /** Open the popover on mount (SharePopover defaultOpen). */
  defaultOpen?: boolean;
  /** The object's short id (pri-N): the popover shows it with Copy ID. */
  copyId?: string;
}) {
  const setObjectShareLink = useInboxStore((s) => s.setObjectShareLink);
  const policyRefusal = usePolicyRefusal("public_sharing_disabled", publicShare?.team);
  const token = publicShare?.token ?? null;
  // The view a person is looking at (a dashboard's filters, a sheet's tab) rides the public link too.
  const query = path.includes("?") ? path.slice(path.indexOf("?")) : "";
  const publicUrl = (t: string) => `${shareOrigin()}${sharePath(publicShare!.kind, t)}${query}`;
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
      linkExtra={linkExtra}
      access={copyId ? <>{access}<CopyId id={copyId} /></> : access}
      openRefusal={publicShare?.openRefusal ?? policyRefusal}
      defaultOpen={defaultOpen}
    />
  );
  return className ? <span className={`inline-flex ${className}`}>{control}</span> : control;
}

function CopyId({ id }: { id: string }) {
  return (
    <div data-copy-id className="flex items-center gap-2">
      <span className="text-xs font-medium text-sol-text-muted">ID</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-sol-text">{id}</code>
      <button
        type="button"
        data-act="copy-id"
        onClick={() => void copyText(id, "ID copied")}
        className="inline-flex items-center rounded-md border border-sol-border px-2 py-1 text-xs font-medium text-sol-text-secondary transition-colors hover:bg-sol-bg-alt hover:text-sol-text [@media(pointer:coarse)]:min-h-11"
      >
        Copy ID
      </button>
    </div>
  );
}
