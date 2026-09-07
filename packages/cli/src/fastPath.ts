/**
 * Verbs that run on every agent spawn or session start, served from a tiny
 * import graph.
 *
 * index.ts cannot host a cheap path: ES module imports are hoisted, so bun
 * loads and evaluates its whole graph (~640 modules, ~6 MB — every command
 * tree, commander, the browser engine client) before the first statement of
 * the file runs. That was ~0.6 s idle and 1–3 s under load for a wrapper whose
 * only job is to exec claude in place. main.ts (the process entry) calls this
 * BEFORE importing index.js, so a claimed verb pays only for the modules it
 * needs. index.ts calls it too, so `bun src/index.ts <verb>` from an older
 * wrapper script keeps working — just at the old cost.
 *
 * Every branch here must reach its module through a dynamic import(): a static
 * import in this file would be paid by every verb, and in the compiled binary
 * the import() is what keeps index.js's bundle lazy.
 */

export function isStableContextFastPath(argv: string[]): boolean {
  return (
    argv[2] === "stable-context" &&
    (argv.length === 3 || (argv.length === 5 && argv[3] === "--client"))
  );
}

/** Runs the verb when argv names a hot-path verb. Returns true when claimed
 *  (the caller must then load nothing else); false hands off to the full CLI. */
export function runFastPath(argv: string[]): boolean {
  const fail = (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(127);
  };
  if (argv[2] === "_disclaimed") {
    // Agent-launch wrapper (see disclaim.ts): exec the rest of argv as a TCC
    // self-responsible process so privacy prompts name the agent, not codecast.
    import("./disclaim.js")
      .then(({ runDisclaimed }) => runDisclaimed(argv.slice(3)))
      .catch(fail);
    return true;
  }
  if (argv[2] === "_build-id" || (argv[2] === "--" && argv[3] === "_build-id")) {
    // Prints the build id of the daemon code this executable carries. The
    // update paths run it on the FRESHLY INSTALLED executable to decide whether
    // the daemon needs bouncing, so it has to be cheap and side effect free:
    // no commander, no preAction, no ensureDaemonRunning, no update check.
    // daemonBuildId.ts imports nothing, so this costs one tiny module.
    import("./daemonBuildId.js")
      .then(({ DAEMON_BUILD_ID }) => console.log(DAEMON_BUILD_ID))
      .catch(fail);
    return true;
  }
  if (isStableContextFastPath(argv)) {
    // SessionStart hook. Stdout must be exactly one stable-context block (or
    // empty): no Commander, no preAction logging or daemon startup, no update
    // check, no config migration write.
    Promise.all([import("./stableContext.js"), import("./config/readAuthConfig.js")])
      .then(([hook, cfg]) =>
        hook.runStableContextHook(
          cfg.readAuthConfig(cfg.defaultConfigDir()),
          hook.parseStableHookClient(argv[4]),
        ),
      )
      .catch(() => {});
    return true;
  }
  return false;
}
