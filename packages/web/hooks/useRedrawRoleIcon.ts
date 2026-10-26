// Redraws a role's icon (roleIcon.ts) through the server's generator. The new
// icon lands on the role row, and so in the store, through the org.roles feed:
// nothing here writes it. `pending` is the role being drawn, for the caller's
// "Drawing…" while the run is out.
import { useState } from "react";
import { toast } from "sonner";

export function useRedrawRoleIcon(): { pending: string | null; run: (roleId: string, hint?: string) => void } {
  const [pending, setPending] = useState<string | null>(null);
  const run = (roleId: string, hint?: string) => {
    setPending(roleId);
    redrawRoleIcon(roleId, hint)
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Could not redraw the icon"))
      .finally(() => setPending((p) => (p === roleId ? null : p)));
  };
  return { pending, run };
}

// TODO(role icons): call the server worker's generator action once it lands.
async function redrawRoleIcon(_roleId: string, _hint?: string): Promise<void> {
  throw new Error("Redrawing icons is not available yet");
}
