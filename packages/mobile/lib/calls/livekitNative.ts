// The ONE place @livekit/react-native (and its WebRTC native module) is
// required. Both are NATIVE deps first shipped in the huddles binary; a JS
// bundle newer than the installed binary (OTA, or a dev server against an old
// build) must not touch them at module scope — a static import resolves the
// native module during initial JS eval and THROWS on any binary that lacks it,
// which auto-rolls the OTA back and strands users on the old version (see
// lib/gestureHandler.tsx: same incident class, same remedy).
//
// Consumers read `livekit` (null when unavailable) and `callsNativeAvailable`;
// callManager refuses to join without it, UI hides the affordances.
import { nativeModulePresent, optionalNative } from "../optionalNative";

let registered = false;
const lk: typeof import("@livekit/react-native") | null = optionalNative(
  nativeModulePresent("LivekitReactNativeModule") ? "LivekitReactNativeModule" : "WebRTCModule",
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  () => require("@livekit/react-native"),
);

export const callsNativeAvailable = lk !== null;
export const livekit = lk;

/** Idempotent: install WebRTC globals for livekit-client. No-op when absent. */
export function ensureLivekitGlobals(): boolean {
  if (!lk || registered) return lk !== null;
  try {
    lk.registerGlobals();
    registered = true;
  } catch {
    return false;
  }
  return true;
}
