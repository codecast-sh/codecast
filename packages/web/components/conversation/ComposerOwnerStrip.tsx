"use client";

/**
 * The line above a session's composer that says what sending does to who
 * drives it (convex lib/sessionTakeOver, shared takeOverBySend):
 *   - a role drives: "Sending takes over from <role>", with Take over | Tell
 *     <role>. Tell sends the words to the role's own session and leaves the
 *     role driving; the choice holds for the session until changed.
 *   - another person drives: the same line naming them; a send takes over.
 *   - you drive and the role waits: "<role> paused while you drive", with
 *     Make driver to hand it back.
 * The take-over line shows while the composer is focused or holds text.
 */

import { memo, useEffect } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { roleShortName, setComposerSendAs, setComposerTell, useComposerOwnership } from "../../lib/composerOwnership";
import { useOwnersFromStore } from "../OwnersBadge";
import { Face as OwnerFace } from "../OwnersMenu";
import { SegmentedToggle } from "../SegmentedToggle";
import { Button } from "../ui/button";

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
  const { driver, role, ownerList, displayFor, session } = owners;
  const me: string | undefined = owners.currentUser?._id?.toString?.();
  const mine = !!me && !standing && (ownerList.includes(me) || session.runner_id === me);
  const fromRole = mine && driver?.kind === "role" && role ? role : null;
  const fromPerson = mine && driver?.kind === "user" && driver.user_id !== me ? displayFor(driver.user_id) : null;
  const paused = mine && driver?.kind === "user" && driver.user_id === me && role ? role : null;
  const telling = !!fromRole && tell;
  const label = fromRole ? (telling ? `Tell ${roleShortName(fromRole.name)}` : "Take over") : fromPerson ? "Take over" : null;
  const tellRole = telling ? fromRole!.name : null;

  useEffect(() => {
    setComposerSendAs(conversationId, label ? { label, tellRole } : null);
    return () => setComposerSendAs(conversationId, null);
  }, [conversationId, label, tellRole]);

  if (paused) {
    return (
      <div className={className}><div data-cc-owner-strip="paused" className={STRIP}>
        <OwnerFace role={paused} size={16} paused />
        <span className="flex-1 min-w-0 truncate"><b className="font-medium text-sol-text">{paused.name}</b> paused while you drive.</span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => owners.applyChange({ driver: { kind: "role" } }, { driver: { kind: "user", user_id: me! } })}
        >
          Make driver
        </Button>
      </div></div>
    );
  }
  if (!active || (!fromRole && !fromPerson)) return null;
  return (
    <div className={className}><div data-cc-owner-strip={fromRole ? "role" : "person"} className={STRIP}>
      {fromRole ? <OwnerFace role={fromRole} size={16} driver /> : <OwnerFace person={{ _id: driver!.kind === "user" ? driver!.user_id : "", ...fromPerson! }} size={16} driver />}
      <span className="flex-1 min-w-0 truncate">
        {telling
          ? <>Goes to <b className="font-medium text-sol-text">{roleShortName(fromRole!.name)}</b>, who stays driver.</>
          : <>Sending takes over from <b className="font-medium text-sol-text">{fromRole ? roleShortName(fromRole.name) : fromPerson!.name}</b>.</>}
      </span>
      {fromRole && (
        <SegmentedToggle
          size="sm"
          value={tell ? "tell" : "take"}
          onChange={(key) => setComposerTell(conversationId, key === "tell")}
          items={[
            { key: "take", label: "Take over", title: "Send here and drive this session; the role pauses" },
            { key: "tell", label: `Tell ${roleShortName(fromRole.name)}`, title: `Send to ${fromRole.name}'s own session; it keeps driving` },
          ]}
        />
      )}
    </div></div>
  );
});
