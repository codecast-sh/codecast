/**
 * Whether the login keychain is locked, asked without raising any UI.
 *
 * Every `security` call against a locked keychain puts an unlock dialog on the
 * person's screen, and the `security` tool has no way to ask for the lock state
 * without one (show-keychain-info prompts too). The Security framework does:
 * SecKeychainGetStatus answers in a few milliseconds and never prompts.
 *
 * The keychain locks while the person is logged in when securityd restarts: its
 * unlock state lives only in that process. On 2026-11-11 securityd aborted at
 * 05:45 under load, and for two hours the daemon's credential timers raised a
 * fresh unlock dialog every 30 seconds (280 of them) until the Mac was rebooted.
 */
const kSecUnlockStateStatus = 1;

type Probe = () => boolean | null;

function loadProbe(): Probe {
  if (process.platform !== "darwin") return () => null;
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const sec = dlopen("/System/Library/Frameworks/Security.framework/Security", {
      SecKeychainCopyDefault: { args: [FFIType.ptr], returns: FFIType.i32 },
      SecKeychainGetStatus: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });
    const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
      CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
    });
    return () => {
      const ref = new BigUint64Array(1);
      if (sec.symbols.SecKeychainCopyDefault(ptr(ref)) !== 0 || !ref[0]) return null;
      const keychain = Number(ref[0]) as import("bun:ffi").Pointer;
      try {
        const status = new Uint32Array(1);
        if (sec.symbols.SecKeychainGetStatus(keychain, ptr(status)) !== 0) return null;
        return (status[0] & kSecUnlockStateStatus) === 0;
      } finally {
        cf.symbols.CFRelease(keychain);
      }
    };
  } catch {
    return () => null; // not under bun: the state is unknown
  }
}

let probe: Probe | null = null;

/** True when the default (login) keychain is locked; false when it is unlocked
 *  or the state cannot be read (not macOS, not under bun). */
export function loginKeychainLocked(): boolean {
  try {
    return (probe ??= loadProbe())() === true;
  } catch {
    return false;
  }
}

export function setKeychainLockProbeForTests(fake: (() => boolean | null) | null): void {
  probe = fake;
}
