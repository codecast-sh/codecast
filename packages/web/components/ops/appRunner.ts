// The calls an app source's board makes as the person: a reader, an action,
// and a fresh read of the manifest, through sources/app.
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";

const api = _api as any;

export type RunOutcome = { ok: boolean; status?: number; text?: string; error?: string; ms?: number; denied?: boolean };
export type ManifestCheck = { ok: boolean; error?: string; readers?: number; actions?: number; watches?: number };

/** The calls the board makes as the person: a reader or an action, and a fresh read of the manifest. */
export type AppRunner = {
  call: (kind: "read" | "do", name: string, argsJson: string, opts: { idempotencyKey?: string }) => Promise<RunOutcome>;
  refresh: () => Promise<ManifestCheck>;
};

/** The runner for one source, through sources/app (read, doAction with yes, refresh). */
export function useAppRunner(sourceRef: string): AppRunner {
  const read = useAction(api.sources.app.read);
  const doAction = useAction(api.sources.app.doAction);
  const refresh = useAction(api.sources.app.refresh);
  return {
    call: (kind, name, args_json, { idempotencyKey }) =>
      kind === "read"
        ? read({ source: sourceRef, reader: name, args_json })
        : doAction({ source: sourceRef, action: name, args_json, yes: true, ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) }),
    refresh: () => refresh({ source: sourceRef }),
  };
}
