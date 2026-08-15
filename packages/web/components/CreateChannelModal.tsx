import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Hash, Lock } from "lucide-react";
import { MemberPicker } from "./chat/ChannelPeople";
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

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[10001] flex items-start justify-center pt-[12vh] animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="bg-sol-bg border border-sol-border rounded-2xl shadow-2xl w-full max-w-[480px] animate-in slide-in-from-bottom-4 fade-in duration-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div className="px-6 pt-6 pb-2 flex items-center gap-2">
          {isPrivate
            ? <Lock className="w-4 h-4 text-sol-yellow shrink-0" />
            : <Hash className="w-4 h-4 text-sol-text-dim shrink-0" />}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Channel name"
            autoFocus
            className="w-full text-xl font-semibold text-sol-text placeholder:text-sol-text-dim/40 bg-transparent outline-none"
          />
        </div>

        <div className="px-6 pb-2">
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topic (optional)"
            className="w-full text-sm text-sol-text-muted placeholder:text-sol-text-dim/30 bg-transparent outline-none"
          />
        </div>

        <div className="px-6 pb-4 text-xs min-h-[18px]">
          {!teamId ? (
            <span className="text-sol-orange">Switch to a team first — channels live in team workspaces</span>
          ) : taken ? (
            <span className="text-sol-red">#{slug} already exists</span>
          ) : slug && slug !== name.trim() ? (
            <span className="text-sol-text-muted">
              Will be created as <span className="text-sol-text">#{slug}</span>
            </span>
          ) : null}
        </div>

        <div className="px-6 pb-3">
          <label className="flex items-center gap-2.5 text-xs text-sol-text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="accent-[var(--sol-yellow)]"
            />
            <span>
              <span className="text-sol-text font-medium">Private</span> — only invited people can
              see it or find its messages
            </span>
          </label>
          {isPrivate && (
            <div className="mt-2">
              <MemberPicker
                exclude={[viewer]}
                autoFocus={false}
                onChange={(ids) => setMemberIds(ids)}
              />
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-sol-border/50 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-sol-text-muted hover:text-sol-text transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!valid}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-sol-blue/20 text-sol-blue border border-sol-blue/40 hover:bg-sol-blue/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Create channel
          </button>
        </div>
      </div>
    </div>
  );
}
