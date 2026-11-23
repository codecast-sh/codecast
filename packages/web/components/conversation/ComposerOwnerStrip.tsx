"use client";

/**
 * The line above a session's composer that says what sending does to its
 * role (lib/composerOwnership composerOwnerLine; convex lib/sessionTakeOver):
 *   - the role is Active: "Sending pauses @role.", with Pause and send |
 *     Tell @role. Tell sends the words to the role's own session and leaves
 *     it Active; the choice holds for the session until changed. It shows
 *     while the composer is focused or holds text, and ends with the key
 *     that sends.
 *   - you paused the role: "@role is paused.", with Resume.
 * Between people there is no line: a send never takes anything over.
 */

import { memo } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore } from "../../store/inboxStore";
import { composerOwnerLine, setComposerSendAs, setComposerTell, useComposerOwnership } from "../../lib/composerOwnership";
import { useOwnersFromStore } from "../OwnersBadge";
import { Face as OwnerFace } from "../OwnersMenu";
import { SegmentedToggle } from "../SegmentedToggle";
import { Button } from "../ui/button";
import { KeyCap } from "../KeyCap";

const STRIP = "flex items-center gap-2 rounded-lg border border-sol-border/60 bg-sol-bg-alt px-3 py-1.5 text-ui text-sol-text-muted";

export const ComposerOwnerStrip = memo(function ComposerOwnerStrip({ conversationId, active, className = "" }: {
  conversationId: string;
  /** The composer is focused or holds text. */
  active: boolean;
  className?: string;
}) {
  const owners = useOwnersFromStore(conversationId);
  const tell = useComposerOwnership((s) => !!s.tell[conversationId]);
  const standing = useInboxStore((s: any) => {
    const row = s.sessions?.[s.resolveLiveSessionId?.(conversationId) ?? conversationId] ?? s.conversations?.[conversationId];
    return !!row?.standing_role_id;
  });
  const line = composerOwnerLine(owners, standing, tell);
  const label = line?.label ?? null;
  const tellRole = line?.tellRole ?? null;
  const me: string | undefined = owners.currentUser?._id?.toString?.();

  // Publish what Send does to the composer's own store, for this session.
  useWatchEffect(() => {
    setComposerSendAs(conversationId, label ? { label, tellRole } : null);
    return () => setComposerSendAs(conversationId, null);
  }, [conversationId, label, tellRole]);

  if (line?.kind === "paused") {
    return (
      <div className={className}><div data-cc-owner-strip="paused" className={STRIP}>
        <OwnerFace role={line.role} size={16} paused />
        <span className="flex-1 min-w-0 truncate"><b className="font-medium text-sol-text">{line.tag}</b> is paused.</span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => owners.applyChange({ driver: { kind: "role" } }, { driver: { kind: "user", user_id: me! } })}
        >
          Resume
        </Button>
      </div></div>
    );
  }
  if (!active || !line) return null;
  const { tag, telling } = line;
  return (
    <div className={className}><div data-cc-owner-strip="active" className={STRIP}>
      <OwnerFace role={line.role} size={16} />
      {/* A phone keeps the role's tag beside the choice, never a sentence cut through it. */}
      <span className="flex-1 min-w-0 truncate">
        <span className="max-sm:hidden">{telling ? "Goes to " : "Sending pauses "}</span>
        <b className="font-medium text-sol-text">{tag}</b>
        <span className="max-sm:hidden">{telling ? ", which stays active." : "."}</span>
      </span>
      <SegmentedToggle
        size="sm"
        value={telling ? "tell" : "take"}
        onChange={(key) => setComposerTell(conversationId, key === "tell")}
        items={[
          { key: "take", label: "Pause and send", title: `Send here; ${tag} pauses until you resume it` },
          { key: "tell", label: `Tell ${tag}`, title: `Send to ${line.role.name}'s own session; it stays active` },
        ]}
      />
      <span className="own-strip-key inline-flex shrink-0 items-center gap-1 text-meta text-sol-text-dim max-sm:hidden" data-owner-strip-key>
        <KeyCap size="xs">↵</KeyCap>{telling ? "tell" : "pause and send"}
      </span>
    </div></div>
  );
});
