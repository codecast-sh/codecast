// The dot on a tab or a tree row whose file a session is editing right now,
// in that session's color. Hover names the session; a press opens its
// conversation beside the editor.

import { memo } from "react";
import { usePresence } from "../../../lib/code/agent/agentStore";
import { openBeside, sessionPanePath } from "../../../lib/stage";
import { tabNavigate } from "../../../src/compat/tabRouting";
import { useSessionFace } from "../../../hooks/useSessionFace";

export const PresenceDot = memo(function PresenceDot({ vaultId, path }: { vaultId: string | null | undefined; path: string }) {
  const sessionId = usePresence(vaultId, path);
  const face = useSessionFace(sessionId);
  if (!sessionId || !face) return null;
  return (
    <span
      role="button"
      tabIndex={-1}
      data-agent-presence={sessionId}
      aria-label={`${face.title} is editing this file`}
      title={`${face.title} is editing this file. Click to open it beside`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        const path = sessionPanePath(sessionId);
        if (!openBeside(path)) tabNavigate(`/inbox?s=${sessionId}`, "push");
      }}
      className="flex size-3 shrink-0 cursor-pointer items-center justify-center"
    >
      <span className="size-1.5 rounded-full ring-2" style={{ background: face.color, ["--tw-ring-color" as string]: `color-mix(in srgb, ${face.color} 30%, transparent)` }} />
    </span>
  );
});
