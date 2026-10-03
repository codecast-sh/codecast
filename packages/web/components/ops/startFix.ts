// Start a fix session from an Ops page (a replay or an issue). Both pages go
// through here so the prompt quoting and the folder rule are one rule: the
// session starts in the project the signal's source is attached to
// (external-data.md: a source's project_id is the codecast project its
// signals attach under), and only a source with no project falls back to
// wherever a new session would start from the page the person is on.
import { toast } from "sonner";
import { defaultNewSessionPath, useInboxStore } from "../../store/inboxStore";
import { resolveContextProjectPath, type ContextPathStoreSlice } from "../../lib/contextProjectPath";
import { spawnSessionWithPrompt } from "../../lib/spawnSession";
import { fixPrompt, type FixFacts } from "./opsModel";

type FixPathState = Parameters<typeof defaultNewSessionPath>[0] & Pick<ContextPathStoreSlice, "projects"> & { opsSources: Record<string, any> };

/** The folder a fix for a signal from `sourceId` starts in. */
export function fixSessionPath(state: FixPathState, sourceId: string | null | undefined): string | undefined {
  const source = sourceId ? state.opsSources[sourceId] : undefined;
  return resolveContextProjectPath(state as unknown as ContextPathStoreSlice, source) ?? defaultNewSessionPath(state) ?? undefined;
}

export function startOpsFixSession(facts: FixFacts, sourceId: string | null | undefined): void {
  const store = useInboxStore.getState();
  spawnSessionWithPrompt({
    prompt: fixPrompt(facts),
    projectPath: fixSessionPath(store as unknown as FixPathState, sourceId),
    failureLabel: "Failed to start the fix session",
  });
  toast.success("Fix session started", { description: "It is in your inbox." });
}
