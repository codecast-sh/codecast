// CallKit + PushKit bridge — the phone-call experience for huddles.
//
// expo-callkit-telecom owns the SYSTEM side: the lock-screen incoming-call UI,
// the AVAudioSession during a CallKit call, and PushKit registration (done
// natively at app launch, so a KILLED app still gets VoIP pushes; the module
// parses the payload and reports the call to CallKit before JS runs). We own
// MEDIA (LiveKit, via callManager) and the CONTROL PLANE (Convex invites).
//
// The seams, and why each is shaped this way:
// - Answer  → CallKit activates the audio session itself. Our joinCall must
//   NOT call LiveKit's AudioSession.startAudioSession on that path (two owners
//   of one session = no audio). joinCall({ callKitManaged: true }) skips it;
//   LiveKit's WebRTC RTCAudioSession picks up CallKit's activation.
// - Media up → fulfillIncomingCallConnected (CallKit shows the timer). Fail →
//   failIncomingCallConnected (CallKit dismisses cleanly, no zombie call).
// - Decline / system end → declineInvite or leaveCall.
// - Ring settled elsewhere (answered on web, caller hung up, TTL) → we
//   reportCallEnded so the lock-screen UI goes away. The signal is the
//   getMyCalls subscription dropping the invite (JS must be up for that; the
//   module's own incomingCallTimeout — set to the invite TTL — is the
//   killed-app backstop).
// - Mute from the system UI (lock screen / CarPlay) → setMuted. Ours → CallKit
//   setMuted, so the system UI never lies.
//
// Guarded like every other native dep here (lib/gestureHandler, livekitNative):
// a JS bundle newer than the binary degrades to the notification ring.
import { AppState } from "react-native";
type EventSubscription = { remove(): void };
import { api } from "@codecast/convex/convex/_generated/api";
import { convex } from "../convex";
import { parseCallRingPush } from "@codecast/shared/contracts";
import {
  acceptInvite,
  declineInvite,
  getCallSnapshot,
  joinCall,
  leaveCall,
  setMuted,
  subscribeCall,
} from "./callManager";

type CallKitApi = typeof import("expo-callkit-telecom");

let ck: CallKitApi | null | undefined;
let ckLoadError: string | null = null;
function getCallKit(): CallKitApi | null {
  if (ck !== undefined) return ck ?? null;
  try {
    // Expo modules register under ExpoModulesCore, not TurboModuleRegistry —
    // requiring is the reliable probe; it throws on a binary without the pod.
    ck = require("expo-callkit-telecom");
  } catch (e: any) {
    ckLoadError = String(e?.message ?? e).slice(0, 300);
    ck = null;
  }
  return ck ?? null;
}

export const callKitAvailable = (): boolean => getCallKit() !== null;

// The CallKit session currently ringing / connected through us, if any:
// CallKit's id ↔ our invite + room. One at a time — a second CallKit call
// while one is up is the OS's "hold/end & accept" flow, which we map to
// end-old + accept-new (huddles have no hold).
type Active = { ckId: string; inviteId: string; roomKey: string; answered: boolean; reportedAt: number };
// A CallKit ring reported from a VoIP push can precede the getMyCalls
// subscription reflecting the invite (PushKit → CallKit is faster than Convex
// propagation). Inside this window, absence from the subscription is not
// evidence the ring settled.
const RING_SETTLE_GRACE_MS = 5_000;
let active: Active | null = null;
let subs: EventSubscription[] = [];
let unsubCall: (() => void) | null = null;
let started = false;

// ── outbound: our state → CallKit ─────────────────────────────────────────

/** Tell CallKit the ring settled (answered elsewhere / cancelled / expired). */
export async function endCallKitRingIfStale(liveInviteIds: Set<string>): Promise<void> {
  const k = getCallKit();
  if (!k || !active || active.answered) return;
  if (liveInviteIds.has(active.inviteId)) return;
  if (Date.now() - active.reportedAt < RING_SETTLE_GRACE_MS) return;
  const { ckId } = active;
  active = null;
  try {
    await k.reportCallEnded(ckId, "remoteEnded");
  } catch {}
}

/** Our call ended (user hung up in-app, or media dropped): mirror to CallKit. */
async function endCallKitCall(reason: "local" | "remoteEnded" | "failed"): Promise<void> {
  const k = getCallKit();
  if (!k || !active) return;
  const { ckId } = active;
  active = null;
  try {
    if (reason === "local") await k.endCall(ckId);
    else await k.reportCallEnded(ckId, reason);
  } catch {}
}

// ── inbound: CallKit → our state ──────────────────────────────────────────

function onSessionAdded(session: any) {
  // Only incoming sessions concern us (we never startOutgoingCall — a huddle
  // starts in-app, no CallKit outgoing UI needed).
  if (session?.origin !== "incoming") return;
  const ev = session.incomingCallEvent;
  const meta = parseCallRingPush(ev?.metadata);
  const inviteId = meta?.invite_id ?? ev?.serverCallId;
  const roomKey = meta?.room_key;
  if (!inviteId || !roomKey) return;
  active = { ckId: session.id, inviteId, roomKey, answered: false, reportedAt: Date.now() };
}

async function onAnswered(ev: { id: string; requestId: string }) {
  const k = getCallKit();
  if (!k || !active || active.ckId !== ev.id) return;
  active.answered = true;
  const { ckId, inviteId, roomKey } = active;
  try {
    // acceptInvite → respondInvite → joinCall; CallKit owns the audio session
    // on this path, so joinCall skips LiveKit's own start.
    await acceptInvite(inviteId, roomKey, { callKitManaged: true });
    if (getCallSnapshot().phase === "connected") {
      await k.fulfillIncomingCallConnected(ev.requestId);
    } else {
      await k.failIncomingCallConnected(ckId, ev.requestId);
      active = null;
    }
  } catch {
    try {
      await k.failIncomingCallConnected(ckId, ev.requestId);
    } catch {}
    active = null;
  }
}

async function onEnded(ev: { id: string }) {
  if (!active || active.ckId !== ev.id) return;
  const { inviteId, answered } = active;
  active = null;
  if (answered) {
    // Ended from the system UI mid-call.
    await leaveCall();
  } else {
    // Declined from the lock screen (or the OS ended it before answer).
    await declineInvite(inviteId);
  }
}

function onSetMuted(ev: { id: string; muted: boolean }) {
  if (!active || active.ckId !== ev.id || !active.answered) return;
  void setMuted(ev.muted);
}

// ── lifecycle ─────────────────────────────────────────────────────────────

/** Mount once (root layout). Idempotent. */
export function startCallKitBridge(): void {
  if (started) return;
  const k = getCallKit();
  if (!k) return;
  started = true;

  const dbg = (name: string, e: any) => {
    if (__DEV__) (global as any).__ckEvents?.push({ name, e: JSON.parse(JSON.stringify(e ?? null)) });
  };
  subs = [
    k.addCallSessionAddedListener((e: any) => { dbg("sessionAdded", e); onSessionAdded(e.session); }),
    k.addCallSessionUpdatedListener((e: any) => dbg("sessionUpdated", e)),
    k.addCallSessionRemovedListener((e: any) => dbg("sessionRemoved", e)),
    k.addCallAnsweredListener((e: any) => { dbg("answered", e); void onAnswered(e); }),
    k.addCallEndedListener((e: any) => { dbg("ended", e); void onEnded(e); }),
    k.addReportedCallEndedListener((e: any) => dbg("reportedEnded", e)),
    k.addIncomingCallReportedListener((e: any) => dbg("incomingReported", e)),
    k.addSetMutedActionListener((e: any) => onSetMuted(e)),
    // PushKit token → server, so invites route through APNs VoIP.
    k.addVoIPPushTokenUpdatedListener((e: any) => void publishVoipToken(e?.token ?? null)),
  ];
  // Cold start: the module queued the incoming session before JS was up.
  void k.getActiveCallSession().then((s: any) => s && onSessionAdded(s)).catch(() => {});
  // Token may already be there.
  const tok = k.getVoIPPushToken?.();
  if (tok?.token) void publishVoipToken(tok.token);

  // Our side → CallKit: hang-up in-app ends the CallKit call; mute in-app
  // updates the system UI.
  let lastPhase = getCallSnapshot().phase;
  let lastMuted = getCallSnapshot().muted;
  unsubCall = subscribeCall(() => {
    const s = getCallSnapshot();
    if (active?.answered) {
      if (lastPhase !== "idle" && s.phase === "idle") void endCallKitCall("local");
      if (s.phase === "error" && lastPhase !== "error") void endCallKitCall("failed");
      if (s.muted !== lastMuted) {
        const k2 = getCallKit();
        if (k2 && active) k2.setMuted(active.ckId, s.muted).catch(() => {});
      }
    }
    lastPhase = s.phase;
    lastMuted = s.muted;
  });
}

export function stopCallKitBridge(): void {
  for (const s of subs) s.remove();
  subs = [];
  unsubCall?.();
  unsubCall = null;
  started = false;
}

let lastPublished: string | null | undefined;
async function publishVoipToken(token: string | null): Promise<void> {
  if (token === lastPublished) return;
  lastPublished = token;
  try {
    await convex.mutation(api.users.storeVoipPushToken, { voip_push_token: token });
  } catch {
    // Not authenticated yet at cold start: the token listener fires again on
    // the next launch, and AuthGate re-runs the bridge start after sign-in.
    lastPublished = undefined;
  }
}

/** Re-publish after auth becomes available (cold start races sign-in). */
export function republishVoipToken(): void {
  const k = getCallKit();
  const tok = k?.getVoIPPushToken?.();
  if (tok?.token && tok.token !== lastPublished) void publishVoipToken(tok.token);
}

if (__DEV__) {
  (global as any).__ckEvents = [] as any[];
  (global as any).__callKit = {
    available: callKitAvailable,
    loadError: () => ckLoadError,
    events: () => (global as any).__ckEvents,
    mod: () => getCallKit(),
    active: () => active,
    // Simulate a VoIP-push-reported ring without APNs (the simulator has no
    // PushKit): reports straight to CallKit, same code path from there on.
    ring: async (inviteId: string, roomKey: string, name = "Teammate") => {
      const k = getCallKit();
      if (!k) return "no-callkit";
      await k.reportIncomingCall({
        eventId: `sim:${Date.now()}`,
        serverCallId: inviteId,
        hasVideo: false,
        caller: { id: "sim", displayName: name },
        metadata: { type: "huddle_ring", invite_id: inviteId, room_key: roomKey },
      } as any);
      return "reported";
    },
  };
}
