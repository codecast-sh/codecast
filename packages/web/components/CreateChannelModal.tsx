import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";
import { SlackLogo } from "./SlackLogo";
import { SlackChannelBrowser } from "./chat/SlackChannelBrowser";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Hash, Lock } from "lucide-react";
import { MemberPicker } from "./chat/ChannelPeople";
import { Switch } from "./ui/switch";
import { CreateDialog, CreateDialogSubtitle, CreateDialogTitle } from "./CreateDialog";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs } from "../hooks/useWorkspaceArgs";
import { inActiveWorkspace } from "../lib/workspaceScope";
import { normalizeChannelName } from "@codecast/convex/convex/chatText";

// New channel.
//
// The app's own modal, beside CreateTaskModal and CreateDocModal, for the same
// reason every other create has one: a window.prompt is unstyled, ignores the
// theme, blocks the main thread, cannot validate, cannot take a topic — and does
// not exist at all in Electron, where prompt() is unimplemented and returns
// nothing. The desktop build's New Channel button was silently dead.
//
// It also shows the SLUG. The store slugs the name before dispatch, so "Design
// Review" becomes "design-review"; making the reader discover that after the
// fact is the kind of small dishonesty that erodes trust in a surface.

// The server's own rule (convex/chatText), under the name this surface has
// always used. A local copy drifted: it kept invalid characters and uncapped
// length, so the previewed slug was not the name the channel got.
export const slugChannelName = normalizeChannelName;

export function CreateChannelModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** Handed the new channel's local id, so the caller can select it in the same
   *  tick — the id is superseded by the server row when it lands. */
  onCreated?: (channelId: string) => void;
}) {
  const createChatChannel = useInboxStore((s) => s.createChatChannel);
  const channels = useInboxStore((s) => s.chatChannels);
  const workspace = useWorkspaceArgs();
  const teamId = workspace !== "skip" && "team_id" in workspace ? String(workspace.team_id) : undefined;
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const viewer = useInboxStore((s) => (s as any).currentUser?._id ?? "");
  // A team with Slack connected can also bring channels over instead of
  // typing a name: the same gesture, from the other side.
  const slack = useQueryNoThrow(api.slackSync.getTeamSlack, teamId ? ({ team_id: teamId } as any) : "skip");
  const [slackOpen, setSlackOpen] = useState(false);

  const slug = slugChannelName(name);
  // Collision check scoped to the target workspace — the store caches channels
  // across teams, and a name taken in another team is free in this one.
  const taken = useMemo(
    () => Object.values(channels).some((c: any) => !c.archived_at && c.name === slug && inActiveWorkspace(c, teamId)),
    [channels, slug, teamId],
  );
  // A channel MUST land in the workspace the user is looking at. Omitting the
  // team would let the server default to users.active_team_id — a second
  // source of truth that can name a team this window is not even showing.
  const valid = slug.length > 0 && !taken && !!teamId;

  const submit = () => {
    if (!valid || !teamId) return;
    const id = createChatChannel(name, {
      topic: topic.trim() || undefined,
      teamId,
      ...(isPrivate ? { kind: "private" as const, memberIds } : {}),
    });
    toast.success(isPrivate ? `Created private channel #${slug}` : `Created #${slug}`);
    onCreated?.(id);
    onClose();
  };

  if (slackOpen && teamId) {
    return (
      <SlackChannelBrowser
        teamId={teamId}
        onClose={onClose}
        onAdded={(channelId) => onCreated?.(channelId)}
      />
    );
  }

  const hint = !teamId ? (
    <span className="text-sol-orange">Switch to a team first: channels live in team workspaces</span>
  ) : taken ? (
    <span className="text-sol-red">#{slug} already exists</span>
  ) : slug && slug !== name.trim() ? (
    <span className="text-sol-text-dim">
      Will be created as <span className="text-sol-text-muted">#{slug}</span>
    </span>
  ) : null;

  return (
    <CreateDialog
      icon={isPrivate
        ? <Lock className="h-3 w-3 text-sol-yellow" />
        : <Hash className="h-3 w-3 text-sol-cyan" />}
      noun={isPrivate ? "private channel" : "channel"}
      onClose={onClose}
      onSubmit={submit}
      canSubmit={valid}
      submitLabel="Create channel"
      submitOnEnter
      footerStart={slack?.data?.installation && (
        <button
          type="button"
          onClick={() => setSlackOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-sol-text-muted transition-colors hover:bg-sol-bg-alt hover:text-sol-text"
          title="Pick channels in the connected Slack workspace; each becomes a mirrored channel here"
        >
          <SlackLogo className="h-3 w-3" /> Add from Slack
        </button>
      )}
    >
      <div className="px-5 pb-4 pt-3">
        <div className="flex items-center gap-1.5">
          <span className="select-none text-xl font-semibold text-sol-text-dim/70">#</span>
          <CreateDialogTitle
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="channel-name"
          />
        </div>
        {hint && <div className="mt-1 pl-[22px] text-xs">{hint}</div>}
        <CreateDialogSubtitle
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="What is it about? (optional)"
          className="mt-2"
        />
      </div>

      <div className="mx-5 mb-4 rounded-lg border border-sol-border/50 bg-sol-bg-alt/30">
        <label className="flex cursor-pointer select-none items-center gap-3 px-3 py-2.5">
          <Lock className={`h-3.5 w-3.5 shrink-0 ${isPrivate ? "text-sol-yellow" : "text-sol-text-dim"}`} />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-sol-text">Private</span>
            <span className="block text-[11px] leading-snug text-sol-text-dim">
              Only people you invite can see it or find its messages
            </span>
          </span>
          <Switch checked={isPrivate} onCheckedChange={setIsPrivate} aria-label="Private channel" />
        </label>
        {isPrivate && (
          <div className="border-t border-sol-border/40 px-3 py-2.5">
            <MemberPicker
              exclude={[viewer]}
              autoFocus={false}
              onChange={(ids) => setMemberIds(ids)}
            />
          </div>
        )}
      </div>
    </CreateDialog>
  );
}
