// The undo card's open acts for someone who lives in the simple lane
// (components/undo/UndoTimeline.tsx UndoCardFrame): a session opens as the
// lane's own conversation page, and nothing else has a page there, so its row
// shows no link rather than throwing the person out into the full app. The
// lane's shell passes it always; a frame both kinds of reader share (the
// standalone /r pages) passes it to a lane reader.
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useInboxStore } from "../../store/inboxStore";
import type { UndoCardFrame } from "../undo/UndoTimeline";
import { conversationPath, isHostedUi } from "./lanePaths";

export function useLaneUndoFrame(): UndoCardFrame {
  const navigate = useNavigate();
  return useMemo(() => ({
    openVisit: (visit) => (visit.sessionId ? () => navigate(conversationPath(visit.sessionId!)) : null),
    openOrg: null,
  }), [navigate]);
}

/** The lane's frame for a lane reader; undefined (the full app's acts) for anyone else. */
export function useReaderUndoFrame(): UndoCardFrame | undefined {
  const lane = useLaneUndoFrame();
  const simple = useInboxStore((s) => isHostedUi(s.clientState?.ui));
  return simple ? lane : undefined;
}
