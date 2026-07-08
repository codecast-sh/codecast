import { View } from 'react-native';

// react-native-gesture-handler's native module is ABSENT on the Feb 1.0.2 App
// Store binary: the dependency was first installed 2026-03-05, AFTER that build
// (build #20, Feb 24) was cut. With the new architecture a static import
// resolves RNGestureHandlerModule via getEnforcing(), which THROWS during
// initial JS evaluation on that binary — before expo-updates can mark the OTA
// "launched" — so every JS-only update silently auto-rolls-back (the
// long-running "stuck on the old version" bug). This module is the ONE place
// gesture-handler is required: probe the native module without throwing, and
// export null / a plain-View fallback when it is missing so the app renders and
// is usable (gestures degrade) until a native build bundles it. Mirrors the
// guarded requires in lib/analytics.ts, lib/clipboard.ts, store/idbCache.native.ts.
function rnGestureHandlerNativeAvailable(): boolean {
  // `getEnforcing` throws when absent, so use the non-throwing `get` (new arch)
  // and the NativeModules map (old arch). This catches the case where requiring
  // the JS succeeds but calling into native would crash.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TurboModuleRegistry, NativeModules } = require('react-native');
    return !!(TurboModuleRegistry?.get?.('RNGestureHandlerModule') || NativeModules?.RNGestureHandlerModule);
  } catch {
    return false;
  }
}

// The whole module namespace, or null when the native module is missing.
// Consumers must handle null with a degraded (or PanResponder) path.
let gh: any = null;
try {
  if (rnGestureHandlerNativeAvailable()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    gh = require('react-native-gesture-handler');
  }
} catch {
  gh = null;
}

export const gestureHandler: any = gh;

export const GestureHandlerRootView: any =
  gh?.GestureHandlerRootView ?? (({ style, children }: any) => <View style={style}>{children}</View>);
