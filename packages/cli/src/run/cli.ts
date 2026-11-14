import type { Command } from "commander";
import { commandGroup } from "../commandGroups.js";
import { ensureUp, readHosts, resolveCloudHost, toRemoteHost, type CloudHost } from "../browser/cloudHost.js";
import { remoteRepoPath } from "../remote/session-move.js";
import { resolveSeedRoots } from "../cloud/prepare.js";
import { createWipSnapshotStrict, CLOUD_SEED_EXCLUDES } from "../wipSnapshot.js";
import { EXIT_BUSY, EXIT_CANCELLED, EXIT_INFRA, EXIT_WAIT_ELAPSED, formatHint } from "../infraExit.js";
import {
  awaitRun,
  estimateUpload,
  fmtBytes,
  fmtMs,
  InfraError,
  listRecords,
  localTransport,
  pickHost,
  planRun,
  probeHost,
  probeHostDetail,
  readRecord,
  dropRecord,
  reportInfra,
  flushAndExit,
  runnerCommand as runnerCmd,
  runnerProgram,
  saveRecord,
  sshTransport,
  stdio,
  submitRun,
  type RunRecord,
  type Transport,
} from "./client.js";
import type { HostInfoWire, RunStateWire } from "./hostRunner.js";

export const RUN_USAGE = `Usage: cast run [options] -- <command...>

Run one command on a cloud host against this checkout as it is now (uncommitted
work included), stream its output here, copy back the outputs its [[run.jobs]]
entry declares, and exit with its exit code. The session stays where it is.
stdin is not forwarded. Outputs come back from failed runs too (a test report
is most useful then), never from cancelled or killed ones. A tracked output
edited here during the run is kept, and the host's copy goes to
~/.codecast/runs/<id>/outputs; a git-ignored output is written over, and one
the run no longer makes stays. Files git ignores (.env and the like) stay here.

Options:
  --host [id]          a registered host (cast remote hosts); default: the least loaded one that has room
  --max-wait <sec>     stop waiting after this long and exit 124; the run continues
  --detach             print the run id once the host accepts it, and return (cast run wait brings its outputs back)
  --env KEY[=VALUE]    pass an environment variable (this machine's value when no =); kept with the run on the host for a day
  --max-upload-mb <n>  allow a bigger snapshot than [run] max_upload_mb (default 50)
  --queue-wait <sec>   how long the host may hold the run in its queue before exit 75 (default 600)
  --dry-run            show the job, the snapshot size and the host; sends only a probe
  -q, --quiet          no cast: progress lines (a hint line still prints)

Commands (a command named like one of these goes after --):
  cast run wait <id> [--max-wait <sec>]   follow a run again from its first line and exit with its code
  cast run cancel <id>                    stop a run on its host
  cast run show <id> [--json]             a run's state and where its time went
  cast run ls [--json]                    this machine's recent runs
  cast run hosts                          each host's free memory, load and running jobs

Exit codes: the command's own, except 70 (the tool failed: a bad flag, host,
transport, setup, out of memory, timeout), 75 (host busy, or outputs changed here during
the run), 124 (--max-wait elapsed, the run continues) and 130 (cancelled). A
command that itself exits with one of these is indistinguishable from the tool;
the last stderr line is then a cast: hint: only when the tool has one.`;

interface RunFlags {
  host?: string | true;
  maxWaitS?: number;
  detach?: boolean;
  env: Record<string, string>;
  maxUploadMb?: number;
  queueWaitS?: number;
  dryRun?: boolean;
  quiet?: boolean;
  json?: boolean;
  help?: boolean;
}

/** Variables that describe the machine itself: the host's own values are the right ones there. */
const MACHINE_ENV = new Set(["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "PWD"]);

const registeredHostId = (word: string) => readHosts().some((h) => h.id === word);

/**
 * cast run's own flags, up to `--` or the command's first word. `rest` and
 * `consumed` index the words as given, so the caller can put `--` exactly
 * there; `--flag=value` is read in place and the command's own `--x=y` is
 * never touched.
 */
export function parseRunArgs(args: string[], isHostId: (word: string) => boolean = registeredHostId): { flags: RunFlags; rest: string[]; consumed: number } {
  const flags: RunFlags = { env: {} };
  let i = 0;
  for (; i < args.length; i++) {
    const raw = args[i]!;
    if (raw === "--") { i++; break; }
    if (!raw.startsWith("-")) break;
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const a = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = () => inline ?? args[++i];
    const num = () => {
      const v = Number(value());
      if (!Number.isFinite(v) || v <= 0) throw new InfraError(`${a} needs a positive number`, undefined, EXIT_INFRA);
      return v;
    };
    if (a === "--host") {
      if (inline !== undefined) { flags.host = inline; continue; }
      // `--host` alone means "pick one". The next word is a host when one is registered by that id, or when `--` follows it.
      const next = args[i + 1];
      // A word shaped like a host id (an EC2 instance, a uuid) that is not registered is a typo, not the command.
      const looksLikeHost = (w: string) => /^i-[0-9a-f]{8,17}$/.test(w) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(w);
      // Without `=` the next word is a host only when it is one: an unregistered word right after --host is refused, never run.
      if (next && !next.startsWith("-") && (isHostId(next) || args[i + 2] === "--" || looksLikeHost(next) || /^i-/.test(next))) {
        if (!isHostId(next)) throw new InfraError(`no cloud host ${next} is registered`, "cast remote hosts lists them", EXIT_INFRA);
        flags.host = next;
        i++;
      } else flags.host = true;
    } else if (a === "--max-wait") flags.maxWaitS = num();
    else if (a === "--detach") flags.detach = true;
    else if (a === "--env") {
      const kv = value() ?? "";
      const at = kv.indexOf("=");
      const key = at < 0 ? kv : kv.slice(0, at);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new InfraError(`--env needs KEY or KEY=VALUE, got ${JSON.stringify(kv)}`, undefined, EXIT_INFRA);
      if (MACHINE_ENV.has(key)) throw new InfraError(`--env ${key} would hand the host this machine's ${key}; the host keeps its own`, undefined, EXIT_INFRA);
      if (at < 0 && process.env[key] === undefined) throw new InfraError(`--env ${key}: ${key} is not set here; pass ${key}=VALUE`, undefined, EXIT_INFRA);
      flags.env[key] = at < 0 ? process.env[key]! : kv.slice(at + 1);
    } else if (a === "--max-upload-mb") flags.maxUploadMb = num();
    else if (a === "--queue-wait") flags.queueWaitS = num();
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "-q" || a === "--quiet") flags.quiet = true;
    else if (a === "--json") flags.json = true;
    else if (a === "-h" || a === "--help") flags.help = true;
    else throw new InfraError(`unknown option ${a} (put the command after --)`, "cast run --help lists the options", EXIT_INFRA);
  }
  return { flags, rest: args.slice(i), consumed: i };
}

/** A transport for a record or a host. CAST_RUN_LOCAL_HOST=<dir> stands a local directory in for the host (tests, e2e). */
function transportFor(host: RunRecord["host"]): Transport {
  if (host.local) return localTransport(host.local, "local");
  // A record keeps the address it was submitted to; the registry knows where the host is now.
  const now = readHosts().find((h) => h.id === host.id);
  if (now?.address) host = hostRecord(now);
  const home = host.homeDir ?? `/home/${host.user}`;
  return sshTransport({ address: host.address, user: host.user, keyPath: host.keyPath, remoteBaseDir: `${home}/work`, homeDir: home }, host.id);
}

function hostRecord(cloud: CloudHost): RunRecord["host"] {
  const r = toRemoteHost(cloud);
  return { id: cloud.id, address: r.address, user: r.user, keyPath: r.keyPath, ...(r.homeDir ? { homeDir: r.homeDir } : {}) };
}

/**
 * Where a run goes: the named host (woken if stopped), else the host this
 * checkout last ran on while it has room, else the least loaded running host
 * with room, else the default host woken. With `wake: false` (a dry run)
 * nothing is started: a stopped host is reported as the one a run would wake.
 */
type Chosen = { host: RunRecord["host"]; info?: HostInfoWire; wouldWake?: boolean; sticky?: CloudHost };

async function chooseHost(flag: string | true | undefined, needGb: number, log: (m: string) => void, seedCwd: string, opts: { wake?: boolean } = {}): Promise<Chosen> {
  const wake = opts.wake !== false;
  const local = process.env.CAST_RUN_LOCAL_HOST;
  if (local) {
    const host = { id: "local", address: "localhost", user: "", keyPath: "", local };
    return { host, ...(await probeHost(transportFor(host)).then((info) => (info ? { info } : {}))) };
  }
  const up = async (cloud: CloudHost) => {
    if (!wake) {
      const info = cloud.address ? await probeHost(transportFor(hostRecord(cloud))) : undefined;
      return { host: cloud.address ? hostRecord(cloud) : { id: cloud.id, address: "", user: cloud.user, keyPath: cloud.keyPath }, ...(info ? { info } : { wouldWake: true }) };
    }
    return { host: hostRecord(await ensureUp(cloud, log)) };
  };
  if (typeof flag === "string") {
    try {
      return await up(resolveCloudHost(flag));
    } catch (e) {
      throw new InfraError((e as Error).message, "cast remote hosts lists the registered hosts; the command did not start");
    }
  }
  // Picking on its own, cast sends runs to Linux hosts (the default a cloud session gets); a Mac host is used when named.
  const cands = readHosts().filter((h) => h.address && h.platform !== "darwin" && h.provider !== "scaleway-mac");
  const last = listRecords().find((r) => r.seedCwd === seedCwd && !r.host.local);
  // A host this checkout used in the last half hour without a tool failure holds its warm dependencies and slots:
  // go there without probing (the host's own queue handles a full host), so a loaded laptop's slow ssh cannot move the run.
  const recent = last && wake && Date.now() - last.createdAt < 30 * 60_000 && last.code !== EXIT_INFRA && last.code !== EXIT_BUSY && last.reason !== "unconfirmed" ? cands.find((h) => h.id === last.host.id) : undefined;
  if (recent) {
    // A short look at its memory: answered without room means another host; no answer means try it anyway (and wake it if it is down).
    const info = await probeHost(transportFor(hostRecord(recent)), 2500);
    if (!info || pickHost([{ host: { id: recent.id }, info }], needGb)) return { host: hostRecord(recent), sticky: recent, ...(info ? { info } : {}) };
  }
  const probes = cands.map((h) => {
    const host = hostRecord(h);
    return probeHost(transportFor(host), 5000).then((info) => (info ? { host, info } : undefined));
  });
  // The host this checkout used last holds its warm dependencies and slots: when it answers with room, take it without waiting on the rest.
  const lastOk = !!last && last.code !== EXIT_INFRA && last.code !== EXIT_BUSY && last.reason !== "unconfirmed";
  const lastIdx = last && lastOk ? cands.findIndex((h) => h.id === last.host.id) : -1;
  if (lastIdx >= 0) {
    const mine = await probes[lastIdx];
    if (mine && mine.info.load1 / mine.info.cpus < 1.5 && pickHost([mine], needGb)) return mine;
  }
  // The first host with room, plus a moment for a less loaded one to answer: a dead host's timeout never holds every run.
  const answered: Array<{ host: RunRecord["host"]; info: HostInfoWire }> = [];
  await new Promise<void>((resolve) => {
    let left = probes.length;
    let grace: ReturnType<typeof setTimeout> | undefined;
    if (!left) resolve();
    for (const p of probes) {
      void p.then((r) => {
        if (r) answered.push(r);
        if (r && !grace && pickHost([r], needGb)) grace = setTimeout(resolve, 750);
        if (--left === 0) { if (grace) clearTimeout(grace); resolve(); }
      });
    }
  });
  const best = pickHost(answered, needGb, lastOk ? last?.host.id : undefined);
  if (best) return best;
  if (answered.length) return answered.sort((a, b) => b.info.memAvailGb - a.info.memAvailGb)[0]!;
  // Nothing answered: wake the host that holds this checkout's warm dependencies, else the default one.
  const fallback = (last && readHosts().find((h) => h.id === last.host.id)) || resolveCloudHost();
  if (!wake) return { ...(await up(fallback)), wouldWake: true };
  log(`no host answered; waking ${fallback.id}`);
  try {
    return await up(fallback);
  } catch (e) {
    throw new InfraError(`no host can take the run: ${(e as Error).message}`, "cast remote hosts shows each host; the command did not start");
  }
}

function hostRepoFor(host: RunRecord["host"], repoRoot: string): string {
  if (host.local) return `${host.local}/src/${repoRoot.split("/").pop()}`;
  const home = host.homeDir ?? `/home/${host.user}`;
  return remoteRepoPath({ address: host.address, user: host.user, keyPath: host.keyPath, remoteBaseDir: `${home}/work`, homeDir: home }, repoRoot);
}

async function mainAction(args: string[]): Promise<number> {
  const { flags, rest } = parseRunArgs(args);
  if (flags.help || !rest.length) {
    (flags.help ? process.stdout : process.stderr).write(`${RUN_USAGE}\n`);
    return flags.help ? 0 : EXIT_INFRA;
  }
  if (flags.json) throw new InfraError("--json is for cast run show and cast run ls; a run's output is the command's own", undefined, EXIT_INFRA);
  const t0 = Date.now();
  const plan = planRun(process.cwd(), rest);
  const needGb = plan.job?.memoryGb ?? 2;
  const log = (m: string) => { if (!flags.quiet) process.stderr.write(`cast: ${m}\n`); };

  if (flags.dryRun) {
    const snap = await createWipSnapshotStrict(plan.seedCwd, { exclude: CLOUD_SEED_EXCLUDES });
    if (!snap) throw new InfraError(`${plan.seedCwd} has no commits to snapshot`);
    const est = estimateUpload(plan.seedCwd, snap.sha);
    const limit = flags.maxUploadMb ?? plan.spec.maxUploadMb;
    const chosen = await chooseHost(flags.host, needGb, log, plan.seedCwd, { wake: false });
    const lines = [
      `command   ${rest.join(" ")}  (in ${plan.cwdRel || "."})`,
      `job       ${plan.job ? `${plan.job.name}: outputs ${plan.job.outputs.join(", ") || "none"}, ${needGb} GB, ${plan.job.timeoutMin ?? 30} min limit` : "none matches; no outputs come back, 2 GB, 30 min limit"}`,
      `snapshot  ${snap.sha.slice(0, 10)} on ${snap.base.slice(0, 10)}${snap.dirty ? ", with uncommitted work" : ", clean"}`,
      `upload    ${fmtBytes(est.bytes)} in ${est.objects} objects beyond origin (the push sends what the host lacks)${est.bytes > limit * 1048576 ? `, OVER the ${limit} MB limit` : ""}`,
      ...est.top.map((d) => `            ${fmtBytes(d.bytes).padStart(8)}  ${d.dir}`),
      ...(plan.notSent.length ? [`not sent  ${plan.notSent.join(", ")} (git ignores them; [setup] copy does not apply to cast run)`] : []),
      `deps      ${plan.install.length ? `keyed by ${plan.spec.depsKey?.join(", ") || "the lockfiles"}, installed with ${plan.install.join(" && ")}` : "no install step"}`,
      `host      ${chosen.host.id}${chosen.info ? `: ${chosen.info.memAvailGb} of ${chosen.info.memTotalGb} GB free, load ${chosen.info.load1.toFixed(1)} on ${chosen.info.cpus} cores, ${chosen.info.active} running, ${chosen.info.queued} queued` : chosen.wouldWake ? ": not answering; a real run would wake it" : ""}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  // Until follow takes over the signals, a killed client only says where the run went; it never cancels it.
  let runId: string | undefined;
  let preparedId: string | undefined;
  let acceptedId: string | undefined;
  let waking = false;
  let tRef: Transport | undefined;
  let exiting = false;
  exitingNow = () => exiting;
  /** A pushed run that was never confirmed is cancelled before we leave: a late submit then refuses, and nothing runs unseen. */
  const cancelUnconfirmed = async () => {
    if (runId && !acceptedId && tRef) await tRef.runAsync(runnerCmd(["cancel", runId]), { input: runnerText(), timeoutMs: 15_000 });
  };
  const early = async (sig: NodeJS.Signals) => {
    // A second signal while the first is still cancelling leaves at once.
    if (exiting) process.exit(sig === "SIGINT" ? EXIT_CANCELLED : 143);
    exiting = true;
    if (sig === "SIGINT" && runId && tRef) {
      // Ctrl-C means stop: cancel whatever reached the host. A submit still on its way finds the cancel waiting.
      await tRef.runAsync(runnerCmd(["cancel", runId]), { input: runnerText(), timeoutMs: 15_000 });
      process.stderr.write(`\ncast: cancelled ${runId}\n`);
      void flushAndExit(EXIT_CANCELLED);
      return;
    }
    // Before the push nothing reached the host: the record it would leave is noise.
    if (!runId && preparedId) dropRecord(preparedId);
    if (acceptedId) process.stderr.write(`\n${formatHint(`run ${acceptedId} continues on the host; cast run wait ${acceptedId} follows it`)}\n`);
    else if (runId) { await cancelUnconfirmed(); process.stderr.write(`\n${formatHint("stopped before the host confirmed the run, and cancelled it there; nothing runs")}\n`); }
    // 124 only once the host has the run; before that a kill is the tool not finishing (70), or the kill itself (143).
    void flushAndExit(sig === "SIGINT" ? EXIT_CANCELLED : acceptedId ? EXIT_WAIT_ELAPSED : runId ? EXIT_INFRA : 143);
  };
  const onEarly = (sig: NodeJS.Signals) => { void early(sig); };
  process.on("SIGTERM", onEarly);
  process.on("SIGHUP", onEarly);
  process.on("SIGINT", onEarly);
  // --max-wait bounds the whole call: a host that has not taken the command by then is the tool not delivering it in time (70).
  const deadline = flags.maxWaitS ? setTimeout(async () => {
    if (acceptedId || exiting) return;
    exiting = true;
    process.stderr.write(`cast: the host had not taken the command after --max-wait ${flags.maxWaitS}s\n`);
    if (runId) { await cancelUnconfirmed(); process.stderr.write(`${formatHint("cancelled it there, so nothing runs; run it again, or allow a longer --max-wait")}\n`); }
    else {
      if (preparedId) dropRecord(preparedId);
      process.stderr.write(`${formatHint(waking ? "the host was still waking up; it stays up, so the same command a minute from now starts at once" : "nothing started; run it again, or allow a longer --max-wait")}\n`);
    }
    void flushAndExit(EXIT_INFRA);
  }, flags.maxWaitS * 1000) : undefined;
  deadline?.unref();
  const tp = Date.now();
  let chosen = await chooseHost(flags.host, needGb, (m) => { if (/start|wak|boot/i.test(m)) waking = true; log(m); }, plan.seedCwd);
  const pickMs = Date.now() - tp;
  const { repoRoot } = resolveSeedRoots(plan.seedCwd);
  const submit = (c: Chosen) => {
    const t = transportFor(c.host);
    tRef = t;
    return submitRun({
      plan,
      transport: t,
      host: c.host,
      hostRepo: hostRepoFor(c.host, repoRoot),
      env: flags.env,
      ...(flags.maxUploadMb ? { maxUploadMb: flags.maxUploadMb } : {}),
      ...(flags.queueWaitS ? { queueWaitS: flags.queueWaitS } : {}),
      quiet: flags.quiet,
      timings: { pickMs },
      onId: (id) => { runId = id; },
      onPrepared: (id) => { preparedId = id; },
      onAccepted: (id) => { acceptedId = id; },
    }).then((rec) => ({ rec, t }));
  };
  let submitted: { rec: RunRecord; t: Transport };
  try {
    submitted = await submit(chosen);
  } catch (e) {
    // The host used last went unprobed; if it did not answer (stopped since, new address), wake it once and try again.
    // Only when the snapshot never reached it: after a push the run may have started there, and a second copy must not.
    if (!(e instanceof InfraError && e.unreachable && chosen.sticky && !runId)) throw e;
    log(`${chosen.sticky.id} did not answer; waking it`);
    chosen = { host: hostRecord(await ensureUp(chosen.sticky, log)) };
    submitted = await submit(chosen);
  }
  const { rec, t } = submitted;
  process.off("SIGTERM", onEarly);
  process.off("SIGHUP", onEarly);
  process.off("SIGINT", onEarly);
  if (deadline) clearTimeout(deadline);
  rec.timings.acceptMs = Date.now() - t0;
  saveRecord(rec);
  if (flags.detach) {
    process.stdout.write(`${rec.id}\n`);
    return 0;
  }
  // --max-wait counts from launch, not from the moment the host accepted: an agent sizing it to a tool-call limit gets its 124 in time.
  const left = flags.maxWaitS ? flags.maxWaitS - (Date.now() - t0) / 1000 : undefined;
  if (left !== undefined && left <= 0) {
    process.stderr.write(`${formatHint(`run ${rec.id} continues on the host; cast run wait ${rec.id} follows it again`)}\n`);
    return EXIT_WAIT_ELAPSED;
  }
  return awaitRun(t, rec, stdio, { maxWaitS: left, quiet: flags.quiet });
}

function recordOrFail(id: string | undefined, extra: string[] = []): RunRecord {
  if (extra.length) throw new InfraError(`unexpected ${extra.join(" ")} after the run id`, undefined, EXIT_INFRA);
  const rec = id ? readRecord(id) : undefined;
  if (!rec) throw new InfraError(`no run ${id ?? "(no id)"} on this machine`, "cast run ls lists this machine's runs", EXIT_INFRA);
  return rec;
}

function statusOf(rec: RunRecord): RunStateWire | null {
  const t = transportFor(rec.host);
  const r = t.run(`${runnerCmd(["status", rec.id])}`, { input: runnerText(), timeoutMs: 30_000 });
  if (r.status !== 0) throw new InfraError(`${rec.host.id} did not answer: ${r.stderr.trim().split("\n").pop() ?? ""}`);
  try { return JSON.parse(r.stdout.toString().trim().split("\n").pop() || "null") as RunStateWire | null; } catch {
    throw new InfraError(`${rec.host.id} answered with something that is not the runner's`, "a line printed by the host's shell startup files (~/.bashrc, ~/.profile) for non-interactive shells; make it print only when interactive");
  }
}

const runnerText = () => runnerProgram().text;

const TIMING_ORDER: Array<[string, string]> = [
  ["pickMs", "pick host"], ["snapshotMs", "snapshot"], ["estimateMs", "size check"], ["prepMs", "host prep"], ["pushMs", "push"], ["submitMs", "submit"],
  ["queueMs", "queue"], ["checkoutMs", "checkout"], ["depsMs", "deps"], ["runMs", "command"], ["outputsMs", "pack outputs"], ["outputsBackMs", "outputs back"],
];

function showRun(rec: RunRecord, state: RunStateWire | null, json: boolean, unreachable = false): void {
  if (json) { process.stdout.write(`${JSON.stringify({ record: rec, state, ...(unreachable ? { host_answered: false } : {}) }, null, 2)}\n`); return; }
  const timings = { ...rec.timings, ...(state?.timings ?? {}) };
  const lines = [
    `${rec.id}  ${rec.argv.join(" ")}`,
    `host      ${rec.host.id}${state ? ` (${state.host})` : ""}, slot ${state?.slot ?? "-"}`,
    `state     ${state ? state.phase : unreachable ? `unknown: ${rec.host.id} is not answering${rec.code !== undefined ? ` (last seen exit ${rec.code})` : ""}` : "gone from the host"}${state?.code !== undefined ? `, exit ${state.code}` : ""}${state?.reason ? ` (${state.reason})` : ""}`,
    `snapshot  ${rec.sha.slice(0, 10)}${rec.dirty ? " with uncommitted work" : ""}, ${fmtBytes(rec.uploadBytes ?? 0)} sent`,
    ...(state?.deps ? [`deps      ${state.deps.clone === "none" ? "none" : `${state.deps.warm ? "warm" : `cold (install ${fmtMs(state.deps.installMs ?? 0)})`}, ${state.deps.clone}`}`] : []),
    ...(state?.outputs ? [`outputs   ${state.outputs.files} files, ${fmtBytes(state.outputs.bytes)}`] : []),
    ...TIMING_ORDER.filter(([k]) => timings[k] !== undefined).map(([k, label]) => `  ${label.padEnd(13)} ${fmtMs(timings[k]!).padStart(6)}`),
    ...(state?.hint ? [formatHint(state.hint)] : []),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** A verb's flags may come before or after its run id. */
export function parseVerbArgs(args: string[]): { flags: RunFlags; rest: string[] } {
  const positional: string[] = [];
  const flagArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-")) { positional.push(a); continue; }
    flagArgs.push(a);
    if (a === "--max-wait" && args[i + 1] !== undefined) flagArgs.push(args[++i]!);
  }
  const { flags, rest } = parseRunArgs(flagArgs);
  if (rest.length) throw new InfraError(`unexpected ${rest.join(" ")}`, undefined, EXIT_INFRA);
  return { flags, rest: positional };
}

async function subAction(verb: string, args: string[]): Promise<number> {
  const { flags, rest } = parseVerbArgs(args);
  if (verb === "ls") {
    const recs = listRecords().slice(0, 30);
    if (flags.json) { process.stdout.write(`${JSON.stringify(recs, null, 2)}\n`); return 0; }
    for (const r of recs) {
      const when = new Date(r.createdAt).toISOString().replace("T", " ").slice(0, 16);
      process.stdout.write(`${r.id}  ${when}  ${r.host.id.padEnd(20)}  ${(r.code === undefined ? "?" : String(r.code)).padStart(3)}  ${r.argv.join(" ")}\n`);
    }
    if (!recs.length) process.stdout.write("no runs yet\n");
    return 0;
  }
  if (verb === "hosts") {
    const hosts = readHosts().filter((h) => h.address);
    const infos = await Promise.all(hosts.map(async (h) => ({ h, r: await probeHostDetail(transportFor(hostRecord(h)), 10_000) })));
    for (const { h, r } of infos) {
      const info = r.info;
      process.stdout.write(info
        ? `${h.id}  ${String(info.memAvailGb).padStart(5)} of ${info.memTotalGb} GB free  load ${info.load1.toFixed(1).padStart(5)} on ${info.cpus} cores  ${info.active} running  ${info.queued} queued  ${info.slots} slots${info.diskFreeGb !== undefined ? `  ${info.diskFreeGb} GB disk` : ""}\n`
        : `${h.id}  ${r.reached ? "answers, but the runner failed" : "not answering"}: ${r.error}\n`);
    }
    return 0;
  }
  const rec = recordOrFail(rest[0], rest.slice(1));
  if (verb === "show") {
    let state: RunStateWire | null | undefined;
    try { state = statusOf(rec); } catch { state = undefined; }
    showRun(rec, state ?? null, !!flags.json, state === undefined);
    return 0;
  }
  if (verb === "wait" && !rec.host.local) {
    // A detached run's host may have gone to sleep since: wake it to collect the result.
    const cloud = readHosts().find((h) => h.id === rec.host.id);
    if (cloud && !(await probeHost(transportFor(rec.host), 10_000))) rec.host = hostRecord(await ensureUp(cloud, (m) => process.stderr.write(`cast: ${m}\n`)));
  }
  const t = transportFor(rec.host);
  if (verb === "cancel") {
    const r = t.run(runnerCmd(["cancel", rec.id]), { input: runnerText(), timeoutMs: 30_000 });
    if (r.status !== 0) throw new InfraError(`${rec.host.id} did not answer: ${r.stderr.trim().split("\n").pop() ?? ""}`);
    process.stderr.write(`cast: cancel sent to ${rec.id}\n`);
    return 0;
  }
  if (verb === "wait") {
    const state = statusOf(rec);
    let seen = state;
    // An unconfirmed submit may still be landing (the host said an earlier attempt was in progress): look again before concluding.
    for (let i = 0; !seen && (rec.reason === "unconfirmed" || !rec.timings?.submitMs) && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      seen = statusOf(rec);
    }
    if (!seen) {
      if (rec.reason === "unconfirmed" || !rec.timings?.submitMs) throw new InfraError(`${rec.host.id} has no run ${rec.id} after 10 seconds`, "it did not start there; run it again");
      throw new InfraError(`run ${rec.id} is not on ${rec.host.id} any more`, "runs are kept on the host for 24 hours");
    }
    return awaitRun(t, rec, stdio, { maxWaitS: flags.maxWaitS, quiet: flags.quiet, interruptCancels: false });
  }
  throw new InfraError(`no cast run verb ${verb}`, undefined, EXIT_INFRA);
}

const VERBS = new Set(["wait", "cancel", "show", "ls", "hosts"]);

/**
 * Put `--` between cast run's own flags and the command before commander
 * parses argv, so a flag of the command (`node --version`) never reaches the
 * program's own options. parseAsync reads process.argv after this runs.
 */
export function shieldCommandArgv(argv: string[]): void {
  const at = argv.indexOf("run", 2);
  if (at < 0) return;
  const args = argv.slice(at + 1);
  if (!args.length || VERBS.has(args[0]!)) return;
  let parsed: ReturnType<typeof parseRunArgs>;
  try {
    parsed = parseRunArgs(args);
  } catch {
    // A flag error is ours to report: shield everything from commander and let the action parse the words as given.
    shieldedArgs = args;
    argv.splice(at + 1, argv.length - at - 1, "--", ...args);
    return;
  }
  // Already shielded only when `--` is what ended cast run's own flags; a `--` inside the command (git log -- path) is the command's.
  if (parsed.rest.length && args[parsed.consumed - 1] !== "--") argv.splice(at + 1 + parsed.consumed, 0, "--");
}

let exitingNow: () => boolean = () => false;

/** The words after `cast run` as typed, when the shield had to wrap them whole. */
let shieldedArgs: string[] | undefined;

export function registerRunCommand(program: Command): void {
  shieldCommandArgv(process.argv);
  program
    .command("run")
    .description(commandGroup("run").description)
    .argument("[args...]")
    // Hand-parsed: commander would take the command's own flags (bun test --bail) as ours.
    .allowUnknownOption()
    .helpOption(false)
    .action(async () => {
      const raw: string[] = ((program as unknown as { rawArgs?: string[] }).rawArgs ?? process.argv).slice();
      const at = raw.indexOf("run", 2);
      const args = shieldedArgs ?? (at >= 0 ? raw.slice(at + 1) : []);
      let code: number;
      try {
        code = args[0] && VERBS.has(args[0]) ? await subAction(args[0], args.slice(1)) : await mainAction(args);
      } catch (e) {
        // A signal handler already on its way out owns what is said and the exit code.
        if (exitingNow()) return;
        code = reportInfra(e);
      }
      if (exitingNow()) return;
      await flushAndExit(code ?? EXIT_INFRA);
    });
}
