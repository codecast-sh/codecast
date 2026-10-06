// The store's server dispatch binding and its failure handler, outside React.
//
// useEnsureDispatch wires these into the live store through a Convex
// useMutation; the multiplayer simulator (docs/architecture/multiplayer-sim-harness.md)
// wires the same two functions to a simulated client. One copy of the ack
// protocol and of the failure rules, whoever transports the call.
import type { DispatchFn } from "@platform/engine";
import { stampDeliveryReceipts } from "./syncDeliveryReceipts";
import { toast } from "sonner";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { isChatRoomRefusal, useInboxStore } from "../store/inboxStore";
import { isPermanentDispatchError } from "../store/mutativeMiddleware";
import { dropRejectedOrgIntent } from "../store/orgSlice";
import { recordSessionCommandDispatchError, SESSION_COMMAND_ACTIONS } from "./sessionCommands";
import { deadRecordingPress } from "./calls/recordingPress";
import { storableActionArgs } from "./tabSafePath";

/** The args of one `dispatch:dispatch` mutation call. */
export type DispatchCallArgs = {
  action: string;
  args: any;
  patches?: any;
  result?: any;
  ack_positions?: true;
};

/**
 * The sync-log ack opt-in latch. It flips false the first time the server
 * rejects the ack_positions arg (see the fallback in makeDispatchBinding), and
 * stays false for every binding that shares the object.
 */
export type DispatchAckState = { ackFlagSupported: boolean };

export function newDispatchAckState(): DispatchAckState {
  return { ackFlagSupported: true };
}

/**
 * The function `_setDispatch` takes: sends one dispatch through `call` (the
 * `dispatch:dispatch` mutation) and unwraps the sync-log ack envelope.
 */
export function makeDispatchBinding(
  call: (args: DispatchCallArgs) => Promise<any>,
  state: DispatchAckState = newDispatchAckState(),
): DispatchFn {
  return (action, raw, patches, result) => {
    // A tab address leaves the browser in its storable form, as the outbox row keeps it (lib/tabSafePath).
    const args = storableActionArgs(action, raw);
    // A Record or Stop press that is no longer a moment never leaves the
    // browser: refused here as final, so the outbox drops it instead of
    // delivering it into a room nobody is still asking to film.
    const dead = deadRecordingPress(action, args);
    if (dead) return Promise.reject(dead);
    // Sync-log write acks (docs/architecture/sync-log-migration.md D8).
    // The flag is a binding concern added at call time, so outbox rows
    // persisted by older bundles get it on redrive too. The envelope is
    // unwrapped HERE and the store owns the protocol (stampSyncAck);
    // the engine sees the same inner result shape as before.
    const sentAt = Date.now();
    const unwrap = (res: any) => {
      if (res && typeof res === "object" && "__syncAckV1" in res) {
        if (Array.isArray(res.__syncAckV2)) {
          stampDeliveryReceipts(useInboxStore.getState(), patches, res.__syncAckV2, sentAt);
        }
        const ack = res.__syncAckV1;
        // Every window stamps its own locks, the host and a follower alike:
        // the follower never stamps a CURSOR (syncMeta replicates from the
        // host, docs/architecture/sync-host.md), and the replicated cursor
        // advancing is what retires its acked locks (syncReplication).
        if (Array.isArray(ack) && ack.length && patches) {
          useInboxStore.getState().stampSyncAck(patches, ack, sentAt);
        }
        return res.result;
      }
      return res;
    };
    if (!state.ackFlagSupported) {
      return call({ action, args, patches, result });
    }
    return call({ action, args, patches, result, ack_positions: true })
      .then(unwrap)
      .catch((error: any) => {
        // Version-skew self-heal: a deployed convex without the optional
        // ack_positions field rejects EVERY flagged dispatch with an
        // ArgumentValidationError naming the extra field, and dispatch is
        // the sole write chokepoint, so without this fallback that skew (a
        // convex revert after web shipped) is a total write outage. Latch
        // off and re-issue the identical call unflagged: one extra
        // round-trip for the whole session, and convergence falls back to
        // value-echo retirement (a permanent invariant). Scoped tightly:
        // retrying on any validation error would double-fire genuinely
        // malformed dispatches.
        const msg = String(error?.message ?? error);
        if (/ArgumentValidationError/i.test(msg) && /ack_positions/.test(msg)) {
          state.ackFlagSupported = false;
          console.warn("[sync] server lacks ack_positions; falling back to unflagged dispatch");
          return call({ action, args, patches, result });
        }
        throw error;
      });
  };
}

// Actions whose caller reverts the painted change and says why in its own
// words (hooks/useRoomRecording, lib/calls/guestDoorActions): the generic
// "didn't go through" line would tell the person the same refusal twice.
const CALLER_REPORTED_ACTIONS = new Set([
  "setRoomRecording",
  "deleteCallRecording",
  "setCallShareVideo",
  "admitGuestKnock",
  "denyGuestKnock",
  "removeCallGuest",
]);

/** The handler `_setDispatchError` takes: a dispatch gave up after its retries. */
export function applyDispatchFailure(action: string, error: unknown, args?: unknown): void {
  console.error(`[sync] dispatch failed after retries: ${action}`, error);
  // COMMAND_ID_REUSED on a send means the server already holds a receipt
  // for this client id: the message was delivered; only a redrive that
  // rebuilt the payload with different bytes (e.g. a pending row persisted
  // before mention expansion was recorded) got refused. Surfacing it would
  // toast "didn't go through" and mark a delivered bubble as failed.
  if (action === "sendMessage" && /COMMAND_ID_REUSED/.test(String((error as Error)?.message ?? error))) {
    return;
  }
  // A read mark is bookkeeping nobody asked for, so its refusal is news
  // about the cache, not about an action: the room it names is one the
  // server no longer shows this viewer (left, removed, the team's chat
  // off). Retire the room locally and say nothing: "Mark channel read
  // didn't go through" names no action the user took.
  if (action === "markChannelRead" && Array.isArray(args) && typeof args[0] === "string" && isChatRoomRefusal(error)) {
    useInboxStore.getState().retireChatChannel(args[0]);
    return;
  }
  useInboxStore.setState(s => ({ dispatchErrors: s.dispatchErrors + 1 }));
  // A permanent rejection is dropped from the outbox (no re-drive will
  // land it), so it's the user's only chance to hear their action didn't
  // take: record it for the platform's feedback surface to render.
  if (isPermanentDispatchError(error) && !CALLER_REPORTED_ACTIONS.has(action)) {
    // An org edit the rail rejected for good has no echo coming: stop
    // replaying its intent, put the draft back, and say so. Only here: a
    // transient exhaustion (a backend timeout) leaves the parked outbox
    // row to re-drive, so its intent stays open and the echo settles it;
    // reverting it would put a ghost back while the accept still lands.
    for (const text of dropRejectedOrgIntent(useInboxStore.getState(), action, args, error)) toast.error(text);
    // A refused daemon command has no echo coming: its painted row ends failed.
    if (SESSION_COMMAND_ACTIONS.has(action) && Array.isArray(args) && typeof args[0] === "string") {
      recordSessionCommandDispatchError(args[0], error);
    }
    useInboxStore.setState({
      lastDispatchFailure: { action, args, message: String((error as Error)?.message ?? error), at: Date.now() },
    });
  }
  if (action === "sendMessage" && Array.isArray(args)) {
    // Args mirror dispatch.sendMessage: [conversation_id, content, image_ids, client_id].
    const [convId, , , clientId] = args as [string?, unknown?, unknown?, string?];
    // The optimistic bubble is the only copy of the user's text once the
    // server rejects the send (nothing was written). Mark it failed so the
    // reconcile prune keeps it and the thread shows "Failed to send"
    // instead of silently dropping what the user typed.
    if (typeof convId === "string" && typeof clientId === "string") {
      useInboxStore.getState().markOptimisticAsFailed(convId, clientId);
    }
    // A send into a conversation whose server row was deleted (cached ghost).
    // Flag it so the view can offer "restore" instead of failing silently.
    if (typeof convId === "string" && /conversation_deleted/.test(String(error))) {
      useInboxStore.getState().markServerDeleted(convId);
    }
  }
  // The same rule for a chat send, through the same one mechanism. Args
  // mirror dispatchChatSend: [channel_id, content, client_id, opts]. The
  // optimistic row is the only copy of what was typed, so mark it failed:
  // the message then renders with its retry affordance instead of sitting
  // there looking sent. A retry re-dispatches the SAME client id, which
  // chat.sendMessage dedupes, so this can never double-post. The reason
  // is the server's own line ("Channel not found", "This channel is
  // archived"), not the client wrapper, so the row can say WHY.
  if (action === "dispatchChatSend" && Array.isArray(args)) {
    const clientId = args[2];
    if (typeof clientId === "string") {
      useInboxStore.getState().markChatSendFailed(clientId, humanizeConvexError(error, ""));
    }
  }
}
