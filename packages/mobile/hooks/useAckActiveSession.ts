// The mobile half of the read model: acknowledge the session the reader is
// actually looking at.
//
// Same three conditions as web (hooks/useAckActiveConversation) and the same
// store action, but presence means something different on a phone. Web asks
// document.visibilityState and document.hasFocus(); here it is the screen
// being focused in the navigator AND the app being foregrounded, so a session
// pushed under another screen, or the whole app in the background, never
// clears its own unread dot.
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { sessionActivityAt, shouldAcknowledge } from "@codecast/shared/contracts";
import { sessionActivityFacts, useInboxStore } from "@codecast/web/store/inboxStore";

export function useAckActiveSession(conversationId: string | null | undefined): void {
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(() => AppState.currentState === "active");
  // The number the card compares the mark against — the last turn ending, or
  // the row's activity watermark when no turn stamp exists. Acknowledging
  // exactly it is what puts the dot out.
  const updatedAt = useInboxStore((s) => {
    if (!conversationId) return 0;
    const row = s.sessions[conversationId] ?? s.conversations[conversationId];
    return sessionActivityAt(sessionActivityFacts(row as any));
  });

  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => sub.remove();
  }, []);

  // Re-runs on arrival and on a new turn, never when the mark itself changes —
  // that is what lets "mark unread" survive until the reader leaves and
  // returns. Guarded by a ref so a re-render at the same (session, watermark)
  // cannot re-dispatch.
  const lastAcked = useRef<string>("");
  useEffect(() => {
    if (!shouldAcknowledge({ conversationId, isActiveView: focused, present: active, updatedAt })) return;
    const key = `${conversationId}:${updatedAt}`;
    if (lastAcked.current === key) return;
    lastAcked.current = key;
    useInboxStore.getState().ackSessionRead(conversationId!, updatedAt);
  }, [conversationId, focused, active, updatedAt]);
}
