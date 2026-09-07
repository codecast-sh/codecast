import { runMirrorTick, type MirrorDeps, type MirrorTickOptions, type MirrorTickReport } from "./push.js";

export function startMirrorScheduler(opts: {
  deps?: Partial<MirrorDeps>;
  intervalMs?: number;
  verifyIntervalMs?: number;
  tick?: (opts: MirrorTickOptions, deps: Partial<MirrorDeps>) => Promise<MirrorTickReport>;
} = {}): { stop: () => Promise<void>; settled: () => Promise<void> } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastVerify = 0;
  let active: Promise<void> = Promise.resolve();
  const run = () => {
    if (controller.signal.aborted) return;
    const verify = Date.now() - lastVerify >= (opts.verifyIntervalMs ?? 30 * 60_000);
    if (verify) lastVerify = Date.now();
    active = (async () => {
      try {
        await (opts.tick ?? runMirrorTick)({ reason: verify ? "mirror_verify" : "mirror_changed", verifyRemote: verify, onlyIfChanged: !verify, signal: controller.signal }, opts.deps ?? {});
      } catch (err) {
        if (!controller.signal.aborted) opts.deps?.log?.(`mirror tick failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(run, opts.intervalMs ?? 60_000);
          timer.unref();
        }
      }
    })();
  };
  run();
  return {
    settled: () => active,
    stop: async () => {
      controller.abort();
      clearTimeout(timer);
      await active;
    },
  };
}
