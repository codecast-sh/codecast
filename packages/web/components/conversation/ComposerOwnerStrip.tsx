"use client";

/**
 * The line above a session's composer under the session_owners model: an
 * agent owner (its role, else the session that started it) answers this
 * session. While the composer is focused or holds text: "<agent> answers here
 * too", with Take it over, which removes every agent owner and makes you an
 * owner. Sending never takes anything over. It draws nothing for a session
 * off the model, nor reads anything past one store selector there: flag off,
 * the composer costs what it did.
 */

import { memo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { mayHandToIn, ownersModelOnFor } from "../../store/sessionOwnersSlice";
import { useSessionOwners } from "../../hooks/useSessionOwners";
import { takeOverChange } from "../../lib/ownersDraft";
import { OwnerFace, ParentSessionFace } from "../OwnersMenu";
import { applyOwnersWithToast } from "../../lib/ownersGestures";
import { Button } from "../ui/button";

const STRIP = "flex items-center gap-2 rounded-lg border border-sol-border/60 bg-sol-bg-alt px-3 py-1.5 text-ui text-sol-text-muted";

export const ComposerOwnerStrip = memo(function ComposerOwnerStrip({ conversationId, active, className = "" }: {
  conversationId: string;
  /** The composer is focused or holds text. */
  active: boolean;
  className?: string;
}) {
  const on = useInboxStore((s) => ownersModelOnFor(s as never, conversationId));
  return on && active ? <OwnerStrip conversationId={conversationId} className={className} /> : null;
});

function OwnerStrip({ conversationId, className }: { conversationId: string; className: string }) {
  const view = useSessionOwners(conversationId);
  const agent = view.agent;
  if (!agent || !view.meId) return null;
  const name = agent.kind === "role" ? agent.role.name : agent.title;
  const takeOver = () => {
    const parent = view.draft.parent;
    const { change, inverse } = takeOverChange(view.draft, view.meId!, { mayRestore: !parent || mayHandToIn(useInboxStore.getState() as never, parent) });
    applyOwnersWithToast(conversationId, change, inverse, `${name} removed`);
  };
  return (
    <div className={className}>
      <div data-cc-owner-strip className={STRIP}>
        {agent.kind === "role" ? <OwnerFace role={agent.role} size={16} /> : <ParentSessionFace sessionId={agent.id} title={agent.title} size={16} />}
        <span className="min-w-0 flex-1 truncate"><span className="font-medium text-sol-text-muted">{name}</span> answers here too</span>
        {view.canEdit && (
          // Keeps the composer's focus: the strip shows only while it is focused.
          <Button type="button" variant="outline" size="xs" onMouseDown={(e) => e.preventDefault()} onClick={takeOver} data-owner-take-over>Take it over</Button>
        )}
      </div>
    </div>
  );
}
