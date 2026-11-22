// What the resource monitor can do on live data. Park and resume ride the
// existing session command paths; the offload commands (preflight, rehearse,
// start, retry, cancel, background) are useOffloadCommands, shared with the
// phone, reporting failures as toasts here.
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useInboxStore, viewerCommandsSession } from "../store/inboxStore";
import { captureError } from "../lib/analytics";
import { serverErrorText } from "../lib/errorCause";
import type { MigrationBatch } from "../lib/migrationPlan";
import { useHibernationCommands } from "./useHibernationCommands";
import type { OffloadPlan, ResourceActions, ResourceSession } from "../components/resources/types";
import type { RehearsalRow } from "../lib/resourceOffload";
import { useOffloadCommands } from "./useOffloadCommands";

/** A preflight and the start it precedes fail for the same reason; one toast says it. */
const showError = (text: string) => toast.error(text, { id: text });

function report(surface: string) {
  return (e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    captureError(err, { surface });
    showError(serverErrorText(err));
  };
}

const REPORTING = { fail: report, notice: showError };

/**
 * Resume each conversation the viewer may command. resumeSession is a daemon
 * command only the runner or second-party owner may send (commandsSession);
 * the server refuses anyone else, so a row the viewer cannot command is not
 * sent (ct-91098 / eg-2899).
 */
export function resumeCommandable(conversationIds: Array<string | undefined>, onError: (e: unknown) => void): void {
  const state = useInboxStore.getState();
  const meId = state.currentUser?._id ? String(state.currentUser._id) : null;
  for (const c of conversationIds) {
    if (!c || !viewerCommandsSession((state.sessions[c] ?? state.conversations[c]) as any, meId)) continue;
    state.resumeSession(c).catch(onError);
  }
}

export function useResourceActions(sessions: ResourceSession[], plans: OffloadPlan[], batches: MigrationBatch[], now: number, rehearsals: RehearsalRow[] = []) {
  const router = useRouter();
  const { request: requestPark } = useHibernationCommands();
  const { commands, plans: checkedPlans, byId } = useOffloadCommands(sessions, plans, batches, now, rehearsals, REPORTING);

  const actions: ResourceActions = {
    ...commands,
    onOpenSession: (id) => { const c = byId.get(id)?.conversationId; if (c) router.push(`/conversation/${c}`); },
    onPark: (ids) => {
      for (const id of ids) {
        const s = byId.get(id);
        if (s?.conversationId && s.deviceId) requestPark(s.conversationId, s.sessionId, s.deviceId);
      }
      toast(`Asked to park ${ids.length} session${ids.length === 1 ? "" : "s"}; each machine checks it is safe first`);
    },
    onResume: (ids) => resumeCommandable(ids.map((id) => byId.get(id)?.conversationId), report("resources.resume")),
  };

  return { actions, plans: checkedPlans };
}
