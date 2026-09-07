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
  if (argv[2] === "_agent-prompt") {
    import("./agentPrompt.js").then(({ runAgentPrompt }) => runAgentPrompt(argv.slice(3))).catch(fail);
    return true;
  }
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
  if (argv[2] === "_boot-bytes") {
    // How many bytes of JavaScript this executable parses before it picks a
    // verb. `import.meta.url` inside a compiled binary names this module in
    // bun's embedded filesystem, so statting it IS the number (ct-49751).
    // `bun build --compile --splitting` leaves that module holding this file
    // and nothing else — 1,499 bytes in the release shape on bun 1.3.14,
    // darwin-arm64, 2,031 without --minify. Without splitting bun concatenates
    // the whole CLI into it and the same probe reads 4,312,289, which is what
    // the release check refuses. Nothing outside a compiled artifact can
    // observe this: the chunking exists only in one.
    Promise.all([import("node:fs"), import("node:url")])
      .then(([fs, url]) => console.log(fs.statSync(url.fileURLToPath(import.meta.url)).size))
      .catch(fail);
    return true;
  }
  if (argv[2] === "_computer-helper-tar") {
    // Why: the `codecast computer.app` tar rides in as a bundled file asset, so
    // the ONLY place its bytes can be observed is a compiled binary at runtime.
    // The release scripts run this on the built artifact to prove the asset
    // survived `bun build --compile` and to record the helper's sha256 in the
    // artifact manifest (ct-49524). Prints the sha256, or "none" when this
    // build carries no helper; writes the bytes to argv[3] when given. Lives
    // beside `_build-id` for the same reason: no commander, no daemon, two
    // tiny modules.
    Promise.all([import("./computer/helperPayload.js"), import("node:crypto"), import("node:fs")])
      .then(([{ computerHelperTar }, crypto, fs]) => {
        const tar = computerHelperTar();
        if (!tar) return console.log("none");
        if (argv[3]) fs.writeFileSync(argv[3], tar);
        console.log(crypto.createHash("sha256").update(tar).digest("hex"));
      })
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
