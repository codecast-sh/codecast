// The one guarded loader for native dependencies.
//
// A JS bundle outlives the binary it was written for: an OTA update, or the dev
// server, runs new JS on a binary built before a native library was added. A
// static import of such a library throws during the first JS evaluation
// (TurboModuleRegistry.getEnforcing, requireNativeModule), before expo-updates
// can mark the update launched, so the update rolls back in silence or the app
// dies at boot. This has taken the app down with gesture-handler, with
// notifications, and with the SVG views.
//
// The convention, enforced by nativeDeps.guard.test.ts:
//   1. A native package that is not in the guard's baseline is never imported
//      statically. Load it through optionalNative, inside the function that
//      needs it.
//   2. Every caller handles null with a degraded path.
//   3. A new native package needs a new binary build. An OTA update can ship
//      the JS that uses it, and that JS must work without it.
//
// The probe comes first because many packages defer their own native lookup to
// the first property access, which happens outside any try around `require`.

/** True when the installed binary has the native module, Expo or Turbo. Never throws. */
export function nativeModulePresent(nativeName: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (require('expo').requireOptionalNativeModule(nativeName)) return true;
  } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TurboModuleRegistry, NativeModules } = require('react-native');
    return !!(TurboModuleRegistry?.get?.(nativeName) || NativeModules?.[nativeName]);
  } catch {
    return false;
  }
}

/**
 * The package `load` requires, or null when the binary lacks `nativeName` or
 * the package fails to evaluate. `load` must be a literal require so Metro
 * bundles it: optionalNative('ExpoAudio', () => require('expo-audio')).
 */
export function optionalNative<T>(nativeName: string, load: () => T): T | null {
  try {
    return nativeModulePresent(nativeName) ? load() : null;
  } catch {
    return null;
  }
}
