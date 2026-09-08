import { readLocalConfig } from "../../config/readLocalConfig.js";
import { isCloudMirrorEnabled } from "../../config/types.js";
import { listCloudRemoteHosts, sshReachable } from "../../browser/cloudHost.js";
import { listScalewayHosts, type RemoteHost } from "../../remote/session-move.js";
import { defaultDeps, pushMirrorToHostAsync, readRemoteMirrorStamp, runMirrorTick } from "./push.js";
import { readProjectRegistrations, unregisterProjectContext } from "./projectRefresh.js";
import { startMirrorScheduler } from "./scheduler.js";
import { watchMirrorParent } from "./process.js";

export function startStandaloneMirror(opts: {
  listHosts?: () => Promise<RemoteHost[]>;
  projectsFile?: string;
  pushCommand?: string;
  verifyCommand?: string;
  intervalMs?: number;
  verifyIntervalMs?: number;
  log?: (message: string) => void;
} = {}): ReturnType<typeof startMirrorScheduler> {
  const log = opts.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  return startMirrorScheduler({
    intervalMs: opts.intervalMs,
    verifyIntervalMs: opts.verifyIntervalMs,
    deps: { log },
    tick: async (tick) => {
      const config = readLocalConfig();
      if (!isCloudMirrorEnabled(config)) return { pushed: [], failed: [], skipped: [] };
      return runMirrorTick(tick, {
        ...defaultDeps(tick.signal),
        readConfig: () => config,
        listHosts: opts.listHosts ?? (async () => {
          const hosts = [...listCloudRemoteHosts(), ...listScalewayHosts()];
          const reachable = await Promise.all(hosts.map((host) => sshReachable(host)));
          tick.signal?.throwIfAborted();
          return hosts.filter((_, index) => reachable[index]);
        }),
        readProjects: (host) => readProjectRegistrations(host, opts.projectsFile),
        retireProjects: async (host, roots) => { for (const root of roots) await unregisterProjectContext(host, root, { file: opts.projectsFile }); },
        push: (host, bytes) => pushMirrorToHostAsync(host, bytes, { signal: tick.signal, command: opts.pushCommand }),
        readStamp: (host) => readRemoteMirrorStamp(host, 20_000, tick.signal, opts.verifyCommand),
        log,
      });
    },
  });
}

export async function runStandaloneMirror(opts: Parameters<typeof startStandaloneMirror>[0] = {}): Promise<void> {
  const runner = startStandaloneMirror(opts);
  await new Promise<void>((resolve, reject) => {
    const signals: NodeJS.EventEmitter = process;
    const keepAlive = setInterval(() => {}, 60_000);
    const unwatchParent = watchMirrorParent(() => runner.stop(), opts.log ?? ((message) => process.stderr.write(`${message}\n`)));
    const stop: () => void = () => {
      signals.removeListener("SIGTERM", onSignal);
      signals.removeListener("SIGINT", onSignal);
      void runner.stop().then(resolve, reject).finally(() => { unwatchParent(); clearInterval(keepAlive); });
    };
    const onSignal = () => { stop(); };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  });
}
