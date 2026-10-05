// The local half's SDK: what `import ... from "codecast-mod/local"` resolves to.
// The CLI bundles it into the local module, and the codecast daemon runs the
// bundle in a Bun Worker on a machine where a person approved this exact
// version. The module has the machine's full access already (it can import
// node:fs and spawn processes itself); `$` adds the codecast side: publishing
// values the mod's UI reads, answering the UI's calls, filing objects, and
// running `cast`.

type Init = { type: "init"; name: string; manifest: any; siteUrl: string; apiToken: string; deviceName: string; castBin: string };
type CallMsg = { type: "call"; id: string; method: string; args: unknown };

type LocalHook = ($: LocalApi, e: any) => unknown;
type Registration = { event: string; matcher?: Record<string, unknown>; hook: LocalHook };
export type LocalOn = (event: string, matcherOrHook: Record<string, unknown> | LocalHook, hook?: LocalHook) => void;
export type LocalRegister = (on: LocalOn) => void | Promise<void>;

export type RunResult = { code: number; stdout: string; stderr: string };

export interface LocalApi {
  /** Publish a value the mod's UI reads with $.local.get(key) and redraws on. Coalesced to one write a second per key. */
  publish(key: string, value: unknown): void;
  objects: {
    create(obj: { prefix: string; title: string; status?: string; fields?: Record<string, unknown>; body?: string }): Promise<{ short_id: string }>;
    update(shortId: string, patch: { title?: string; status?: string; fields?: Record<string, unknown>; body?: string }): Promise<void>;
  };
  /** Run a cast command: $.cast(["task", "ls", "--json"]). */
  cast(argv: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<RunResult>;
  /** Run a shell command line in a login shell. */
  sh(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<RunResult>;
  every(ms: number, fn: () => unknown): () => void;
  after(ms: number, fn: () => unknown): () => void;
  readonly device: string;
  readonly manifest: any;
}

const hooks: Registration[] = [];
let init: Init | null = null;
const pendingPublish = new Map<string, unknown>();
let publishTimer: ReturnType<typeof setTimeout> | null = null;

function post(msg: unknown): void {
  (globalThis as any).postMessage(msg);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack ? `${err.message}\n${err.stack.split("\n").slice(1, 6).join("\n")}` : err.message;
  return String(err);
}

async function api(path: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${init!.siteUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: init!.apiToken, ...body }),
  });
  const json = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as any;
  if (json?.error) throw new Error(String(json.error));
  return json;
}

function flushPublish(): void {
  publishTimer = null;
  const batch = [...pendingPublish.entries()];
  pendingPublish.clear();
  for (const [key, value] of batch) {
    api("/cli/mods/publish-state", { name: init!.name, key, value, device_name: init!.deviceName }).catch((err) => console.error(`publish ${key}: ${errorText(err)}`));
  }
}

async function run(argv: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  const proc = Bun.spawn(argv, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : null;
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
}

function makeApi(): LocalApi {
  return {
    publish(key, value) {
      pendingPublish.set(key, value);
      if (!publishTimer) publishTimer = setTimeout(flushPublish, 1000);
    },
    objects: {
      create: async (obj) => api("/cli/objects/create", obj as any),
      update: async (shortId, patch) => { await api("/cli/objects/update", { short_id: shortId, ...patch }); },
    },
    cast: (argv, opts) => run([init!.castBin, ...argv], opts),
    sh: (command, opts) => run([process.env.SHELL || "/bin/sh", "-lc", command], opts),
    every(ms, fn) {
      const t = setInterval(() => { Promise.resolve().then(fn).catch((err) => console.error(`every(${ms}): ${errorText(err)}`)); }, Math.max(ms, 1000));
      return () => clearInterval(t);
    },
    after(ms, fn) {
      const t = setTimeout(() => { Promise.resolve().then(fn).catch((err) => console.error(`after(${ms}): ${errorText(err)}`)); }, ms);
      return () => clearTimeout(t);
    },
    get device() { return init!.deviceName; },
    get manifest() { return init!.manifest; },
  };
}

function captureConsole(): void {
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      const text = args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
      post({ type: "log", level, text: `[local] ${text}`.slice(0, 4000) });
    };
  }
}

/** Called by the bundle's entry with the local module's `register`. */
export function start(register: LocalRegister | undefined): void {
  captureConsole();
  const $ = makeApi();
  (globalThis as any).onmessage = async (ev: MessageEvent) => {
    const msg = ev.data as Init | CallMsg;
    if (msg?.type === "init") {
      init = msg;
      if (typeof register !== "function") return post({ type: "failed", error: "the local module must export register(on)" });
      try {
        await register((event, matcherOrHook, hook) => {
          if (typeof matcherOrHook === "function") hooks.push({ event, hook: matcherOrHook as LocalHook });
          else if (typeof hook === "function") hooks.push({ event, matcher: matcherOrHook, hook });
        });
        post({ type: "ready", hooks: hooks.map(({ event, matcher }) => ({ event, matcher })) });
        for (const h of hooks.filter((h) => h.event === "local.start")) await h.hook($, { device: init.deviceName });
      } catch (err) {
        post({ type: "failed", error: errorText(err) });
      }
      return;
    }
    if (msg?.type === "call") {
      const hook = hooks.find((h) => h.event === "local.call" && (!h.matcher || h.matcher.method === msg.method));
      try {
        if (!hook) throw new Error(`the local half answers no call "${msg.method}"`);
        const result = await hook.hook($, { method: msg.method, args: msg.args });
        post({ type: "result", id: msg.id, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
      } catch (err) {
        post({ type: "result", id: msg.id, error: errorText(err) });
      }
    }
  };
}
