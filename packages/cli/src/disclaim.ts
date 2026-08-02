/**
 * macOS TCC responsibility disclaim for spawned agent processes.
 *
 * Every process the daemon starts — the tmux server, pane shells, and the
 * agents inside them — inherits the daemon as its "responsible process", so
 * macOS attributes agents' privacy-protected file access (App Data, Photos,
 * etc.) to the DAEMON's binary: prompts say "codecast would like to access
 * data from other apps" (or "bun" on a from-source install) for reads the
 * daemon never performed, and every distinct app an agent touches raises a
 * fresh prompt against codecast's identity.
 *
 * The fix is the same one Chromium uses for its helpers: posix_spawn with
 * POSIX_SPAWN_SETEXEC (exec semantics — replaces this process image, keeps
 * the pid) plus responsibility_spawnattrs_setdisclaim, which makes the
 * spawned image responsible for itself. Agent launch commands are prefixed
 * with `<cast> _disclaimed --`, so the pane shell runs this wrapper, the
 * wrapper execs the agent command disclaimed, and the agent (a signed binary
 * like Claude Code) carries its own TCC identity: prompts name the agent,
 * and grants persist under the agent vendor's stable code signature.
 *
 * responsibility_spawnattrs_setdisclaim is private API (present in libSystem
 * since 10.14). Everything here degrades gracefully: if the symbol is missing
 * or FFI is unavailable, the wrapper falls back to a plain passthrough spawn
 * that preserves behavior (just without the disclaim).
 */

const POSIX_SPAWN_SETEXEC = 0x0040;

/** Shell prefix that routes an agent launch through the disclaim wrapper.
 *  Returns "" off-macOS or when disabled via CODECAST_NO_DISCLAIM=1 (the
 *  kill switch if a platform update ever breaks the private API). The
 *  remainder of the command line MUST be plain argv tokens (it is executed
 *  via posix_spawnp, not a shell) — both call sites start with `env ...`. */
export function buildDisclaimShellPrefix(
  castBin: string,
  opts: { platform?: NodeJS.Platform; env?: Record<string, string | undefined> } = {},
): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== "darwin" || env.CODECAST_NO_DISCLAIM === "1") return "";
  return `${castBin} _disclaimed -- `;
}

/** Exec argv[0..] in place of this process, disclaimed. Only returns on
 *  failure (errno, or -1 when the FFI path is unavailable). */
export function execDisclaimed(argv: string[]): number {
  if (process.platform !== "darwin") return -1;
  let ffi: typeof import("bun:ffi");
  try {
    ffi = require("bun:ffi");
  } catch {
    return -1;
  }
  const { dlopen, FFIType, ptr } = ffi;
  const open = () =>
    dlopen("libSystem.B.dylib", {
      posix_spawnattr_init: { args: [FFIType.ptr], returns: FFIType.i32 },
      posix_spawnattr_setflags: { args: [FFIType.ptr, FFIType.i16], returns: FFIType.i32 },
      responsibility_spawnattrs_setdisclaim: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      posix_spawnp: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
  let lib: ReturnType<typeof open>;
  try {
    lib = open();
  } catch {
    return -1; // symbol gone (future macOS) → caller falls back to passthrough
  }

  const cstr = (s: string) => Buffer.from(s + "\0", "utf8");
  // char** = pointer array of NUL-terminated strings + NULL terminator. The
  // `bufs` array keeps every Buffer referenced until posix_spawnp returns.
  const cstrArray = (strings: string[], bufs: Buffer[]) => {
    const arr = new BigUint64Array(strings.length + 1);
    strings.forEach((s, i) => {
      const b = cstr(s);
      bufs.push(b);
      arr[i] = BigInt(ptr(b));
    });
    arr[strings.length] = 0n;
    return arr;
  };

  const keep: Buffer[] = [];
  const attr = Buffer.alloc(8); // posix_spawnattr_t is a single pointer on darwin
  if (lib.symbols.posix_spawnattr_init(ptr(attr)) !== 0) return -1;
  if (lib.symbols.responsibility_spawnattrs_setdisclaim(ptr(attr), 1) !== 0) return -1;
  if (lib.symbols.posix_spawnattr_setflags(ptr(attr), POSIX_SPAWN_SETEXEC) !== 0) return -1;

  const file = cstr(argv[0]);
  const argvArr = cstrArray(argv, keep);
  const envStrings = Object.entries(process.env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  const envArr = cstrArray(envStrings, keep);

  const pidOut = Buffer.alloc(4);
  // Only the real disclaim path can print this (the passthrough fallback
  // never reaches here) — lets tests and field debugging tell them apart.
  if (process.env.CODECAST_DISCLAIM_DEBUG === "1") {
    console.error(`_disclaimed: attrs ok, exec'ing ${argv[0]} disclaimed`);
  }
  // SETEXEC: on success this call never returns — the process image is
  // replaced by argv[0] with the disclaim already applied to our pid.
  return lib.symbols.posix_spawnp(ptr(pidOut), ptr(file), null, ptr(attr), ptr(argvArr), ptr(envArr));
}

/** Entry point for `cast _disclaimed -- <cmd> [args...]`. Execs the command
 *  disclaimed; falls back to a passthrough child that mirrors stdio, signals,
 *  and exit code when the disclaim path is unavailable. */
export function runDisclaimed(rawArgs: string[]): void {
  const argv = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  if (argv.length === 0) {
    console.error("usage: cast _disclaimed -- <command> [args...]");
    process.exit(2);
  }

  execDisclaimed(argv); // only returns on failure

  const { spawn } = require("child_process") as typeof import("child_process");
  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      try { child.kill(sig); } catch {}
    });
  }
  child.on("error", (err) => {
    console.error(`_disclaimed: ${err.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal); } catch {}
      process.exit(128);
    }
    process.exit(code ?? 0);
  });
}
