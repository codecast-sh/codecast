// The ONE place @livekit/react-native (and its WebRTC native module) is
// required. Both are NATIVE deps first shipped in the huddles binary; a JS
// bundle newer than the installed binary (OTA, or a dev server against an old
// build) must not touch them at module scope — a static import resolves the
// native module during initial JS eval and THROWS on any binary that lacks it,
// which auto-rolls the OTA back and strands users on the old version (see
// lib/gestureHandler.tsx: same incident class, same remedy).
//
// The package loads on first use (getLivekit), never at boot: evaluating the
// SDK and livekit-client cost a few hundred milliseconds of every launch,
// though only a call needs them. `callsNativeAvailable()` is the binary check
// alone, so UI can hide its affordances without loading anything; callManager
// still refuses to join when the package itself fails to load.
import { nativeModulePresent, optionalNative } from "../optionalNative";

let nativeName: string | null = null;
const livekitNativeName = () =>
  (nativeName ??= nativeModulePresent("LivekitReactNativeModule") ? "LivekitReactNativeModule" : "WebRTCModule");

let nativeAvailable: boolean | null = null;
/** True when the binary has LiveKit's native module. */
export const callsNativeAvailable = () => (nativeAvailable ??= nativeModulePresent(livekitNativeName()));

type Livekit = typeof import("@livekit/react-native");

let registered = false;
let loaded: { lk: Livekit | null } | null = null;

/** @livekit/react-native, or null on a binary without it. */
export function getLivekit(): Livekit | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  loaded ??= { lk: optionalNative(livekitNativeName(), () => require("@livekit/react-native")) };
  return loaded.lk;
}

/** Idempotent: install WebRTC globals for livekit-client. No-op when absent. */
export function ensureLivekitGlobals(): boolean {
  const lk = getLivekit();
  if (!lk || registered) return lk !== null;
  try {
    lk.registerGlobals();
    registered = true;
  } catch {
    return false;
  }
  return true;
}
