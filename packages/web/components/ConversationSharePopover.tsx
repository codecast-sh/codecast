// The share popover for one conversation, wherever its header renders (the
// inbox page and the global session panel): the team level, who can open its
// one link, and that link.
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useTeamShareActions } from "../hooks/useTeamShareActions";
import { useInboxStore } from "../store/inboxStore";
import { shareOrigin } from "../lib/utils";
import { SharePopover } from "./SharePopover";

export function ConversationSharePopover({ conversation, canManage }: { conversation: any; canManage: boolean }) {
  const convId = conversation._id as Id<"conversations">;
  const { setPrivate, shareWithTeam } = useTeamShareActions(convId);
  const setShareLink = useInboxStore((s) => s.setShareLink);
  const pageUrl = `${shareOrigin()}/conversation/${convId}`;
  // The link that works for anyone must PRESENT the token (?share=): a bare
  // conversation id grants nothing to anonymous viewers or link unfurlers
  // (issue #27).
  const withToken = (token: string) => `${pageUrl}?share=${encodeURIComponent(token)}`;
  return (
    <SharePopover
      canManage={canManage}
      isPrivate={conversation.is_private !== false}
      teamVisibility={conversation.team_visibility || conversation.effective_team_visibility}
      hasShareToken={!!conversation.share_token}
      hasTeam={!!conversation.team_id}
      teamId={conversation.team_id ?? null}
      onSetPrivate={setPrivate}
      onSetTeamVisibility={shareWithTeam}
      onGenerateShareLink={async () => {
        const token = conversation.share_token ?? crypto.randomUUID();
        setShareLink(convId, token);
        return withToken(token);
      }}
      onRevokeShareLink={async () => setShareLink(convId, null)}
      shareUrl={conversation.share_token ? withToken(conversation.share_token) : null}
      pageUrl={pageUrl}
      forwardLabel="session"
      // The repo whose team mapping shared this session, so the popover can say why.
      sharedVia={conversation.auto_shared ? (conversation.git_root || conversation.project_path || null) : null}
    />
  );
}
