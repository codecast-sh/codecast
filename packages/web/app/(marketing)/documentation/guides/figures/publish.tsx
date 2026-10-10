"use client";

import { CommentFlow } from "../../../features/publish/Comments";
import { GateScreens } from "../../../features/publish/Gates";
import { ConversationMock } from "../../../features/publish/Places";
import { PUBLISH_CSS } from "../../../features/publish/motion";

/**
 * Figures for the publish guide, drawn with the publish feature page's own
 * pieces: a page link in a conversation, the gates a reader meets, and the
 * way a reader's comment reaches the agent.
 */

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="pb-root p-3 sm:p-5">
      <style>{PUBLISH_CSS}</style>
      {children}
    </div>
  );
}

/** A published page in the conversation that made it: framed when its link stands alone, a pill inside a sentence. */
export function PageInConversationFigure() {
  return <Frame><ConversationMock /></Frame>;
}

/** The screens a reader meets when a page has a password, an email gate or an expiry. */
export function GateScreensFigure() {
  return <Frame><GateScreens /></Frame>;
}

/** A reader pins a note, the owner sends it, the agent gets it as one message. */
export function CommentFlowFigure() {
  return <Frame><CommentFlow /></Frame>;
}
