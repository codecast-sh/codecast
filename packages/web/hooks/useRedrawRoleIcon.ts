// Redraws a role's icon (roleIcon.ts) through the server's generator
// (roleIcons.generate, an action that runs 20 to 40 s). The new icon lands on
// the role row, and so in the store, through the org.roles feed: nothing here
// writes it. `pending` is the role being drawn, for the caller's working state;
// `rationale` is the judge's word on the drawing it kept.
import { useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";

export function useRedrawRoleIcon(): { pending: string | null; rationale: string | null; run: (roleId: string, hint?: string) => void } {
  const generate = useAction(api.roleIcons.generate);
  const [pending, setPending] = useState<string | null>(null);
  const [rationale, setRationale] = useState<string | null>(null);
  const run = (roleId: string, hint?: string) => {
    setPending(roleId);
    setRationale(null);
    generate({ role_id: roleId, ...(hint ? { hint } : {}) })
      .then((r) => setRationale(r.rationale || null))
      // The server's errors are sentences meant for the person; an older
      // deployment without the function answers "Could not find public function".
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message.replace(/^[\s\S]*Uncaught Error:\s*/, "").split("\n")[0] : "Could not draw the icon"))
      .finally(() => setPending((p) => (p === roleId ? null : p)));
  };
  return { pending, rationale, run };
}
