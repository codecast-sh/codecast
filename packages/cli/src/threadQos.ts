/**
 * Raise the calling thread to user-interactive QoS on macOS.
 *
 * The daemon is the control plane for every agent on the machine, but its JS
 * thread runs at default priority (31), the same as the hundreds of agents,
 * tests and typecheckers it supervises. At load 700 on 16 cores (2026-10-16) it
 * spent 7345 s of one day with its event loop frozen and only 654 s of that on
 * CPU: runnable, not busy. Heartbeats lapsed and every session waiting on a
 * reply read "unresponsive". A user-interactive thread is scheduled ahead of
 * that work (timer lag at load 600: worst 7 ms vs 136 ms). Children do not
 * inherit a thread's QoS, so the fleet's priority is unchanged.
 */
const QOS_CLASS_USER_INTERACTIVE = 0x21;

export function raiseThreadToInteractiveQos(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("libSystem.B.dylib", { pthread_set_qos_class_self_np: { args: [FFIType.u32, FFIType.i32], returns: FFIType.i32 } });
    return lib.symbols.pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0) === 0;
  } catch {
    return false; // not under bun, or no libSystem: stay at the default priority
  }
}
