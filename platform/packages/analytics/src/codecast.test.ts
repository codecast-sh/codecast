import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  DEFAULT_CODECAST_INGEST_ENDPOINT,
  backoffMs,
  classifyStatus,
  createCodecastSink,
  type CodecastSinkConfig,
} from "./codecast";

type Sent = { url: string; init: RequestInit; json: any };

async function readBody(init: RequestInit): Promise<any> {
  const headers = (init.headers ?? {}) as Record<string, string>;
  if (headers["Content-Encoding"] === "gzip") {
    const bytes = init.body as Uint8Array;
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(init.body as string);
}

/** A fake door: answers each request with the next status in line (then 202). */
function door(statuses: number[] = [], headers: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init, json: await readBody(init) });
    const status = statuses.shift() ?? 202;
    return new Response(status === 202 ? '{"accepted":1}' : "no", { status, headers });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

/** Manual timers so the tests decide when a flush or a backoff fires. */
function timers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id: unknown) => void pending.delete(id as number),
    runAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const t of due) t.fn();
    },
  };
}

// gzip runs on a stream, so a send lands a few ticks after the timer fires.
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

function sinkWith(extra: Partial<CodecastSinkConfig> = {}, statuses: number[] = [], headers: Record<string, string> = {}) {
  const d = door(statuses, headers);
  const clock = timers();
  const sink = createCodecastSink({
    ingestKey: "cc_ing_abc",
    endpoint: "https://ingest.test/cli/ingest",
    release: "1.2.3",
    environment: "production",
    fetch: d.fetch,
    now: () => 1000,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...extra,
  });
  return { sink, sent: d.sent, clock };
}

describe("createCodecastSink", () => {
  it("defaults to codecast prod and refuses a missing key", () => {
    const sink = createCodecastSink({ ingestKey: "cc_ing_x", fetch: door().fetch });
    expect(sink.endpoint).toBe(DEFAULT_CODECAST_INGEST_ENDPOINT);
    expect(DEFAULT_CODECAST_INGEST_ENDPOINT).toBe("https://convex.codecast.sh/cli/ingest");
    sink.close();
    expect(() => createCodecastSink({ ingestKey: "" })).toThrow();
    expect(() => createCodecastSink({ ingestKey: "k", endpoint: "ftp://x" })).toThrow();
  });

  it("batches items behind a timer and posts the envelope to <endpoint>/<key>", async () => {
    const { sink, sent, clock } = sinkWith();
    sink.check("db", false, { title: "db down" });
    sink.event("signup", { plan: "pro" });
    sink.deploy("1.2.3", { sha: "abc" });
    sink.jobFailed("email", new Error("smtp"), { attempt: 2, jobId: "j1" });
    expect(sent.length).toBe(0);
    expect(clock.pending.size).toBe(1);
    expect([...clock.pending.values()][0].ms).toBe(5000);
    clock.runAll();
    await until(() => sent.length === 1 && sink.pending === 0);
    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe("https://ingest.test/cli/ingest/cc_ing_abc");
    expect(sent[0].json.sdk.name).toBe("@platform/analytics");
    expect(sent[0].json.release).toBe("1.2.3");
    expect(sent[0].json.environment).toBe("production");
    expect(sent[0].json.items).toEqual([
      { type: "check", id: "db", ok: false, title: "db down", at: 1000 },
      { type: "event", name: "signup", props: { plan: "pro" }, at: 1000 },
      { type: "deploy", version: "1.2.3", sha: "abc", environment: "production", at: 1000 },
      { type: "job_failed", job: "email", error: "smtp", attempt: 2, job_id: "j1", at: 1000 },
    ]);
    expect(sink.pending).toBe(0);
  });

  it("gzips the body where CompressionStream exists", async () => {
    const { sink, sent } = sinkWith();
    sink.event("x");
    await sink.flush();
    expect((sent[0].init.headers as Record<string, string>)["Content-Encoding"]).toBe("gzip");
    expect(sent[0].json.items[0].name).toBe("x");
  });

  it("sends at once when a batch fills", async () => {
    const { sink, sent } = sinkWith({ maxBatch: 2 });
    sink.event("a");
    sink.event("b");
    await until(() => sent.length === 1);
    expect(sent.length).toBe(1);
    expect(sent[0].json.items.length).toBe(2);
  });

  it("only sends logs at warn and above", async () => {
    const { sink, sent } = sinkWith();
    sink.log("debug", "noise");
    sink.log("info", "noise");
    sink.log("warn", "careful", { a: 1 });
    sink.log("fatal", "dead");
    await sink.flush();
    expect(sent[0].json.items.map((i: any) => i.level)).toEqual(["warn", "fatal"]);
  });

  it("captureError carries the user, the replay id and the page, and tells listeners", async () => {
    const { sink, sent } = sinkWith();
    const heard: any[] = [];
    sink.onError((item) => heard.push(item));
    sink.setUser({ id: "u1" });
    sink.setReplayId("rp-1");
    sink.captureError(new Error("boom"), { tags: { area: "x" }, url: "https://app.test/a" });
    sink.captureError("plain string");
    await sink.flush();
    const [first, second] = sent[0].json.items;
    expect(first.message).toBe("boom");
    expect(first.stack).toContain("boom");
    expect(first.user).toEqual({ id: "u1" });
    expect(first.replay_id).toBe("rp-1");
    expect(first.url).toBe("https://app.test/a");
    expect(first.tags).toEqual({ area: "x" });
    expect(second.message).toBe("plain string");
    expect(heard.length).toBe(2);
  });

  it("stops for good on 401: the queue goes and nothing more is sent", async () => {
    const { sink, sent } = sinkWith({}, [401]);
    sink.event("a");
    await sink.flush();
    expect(sink.stopped).toBe(true);
    sink.event("b");
    await sink.flush();
    expect(sent.length).toBe(1);
    expect(sink.pending).toBe(0);
  });

  it("drops a batch the door refuses with 400 and keeps sending", async () => {
    const { sink, sent } = sinkWith({}, [400]);
    sink.event("bad");
    await sink.flush();
    sink.event("good");
    await sink.flush();
    expect(sent.map((s) => s.json.items[0].name)).toEqual(["bad", "good"]);
    expect(sink.stopped).toBe(false);
  });

  it("retries 429 and 5xx after a backoff, in order, honoring Retry-After", async () => {
    const { sink, sent, clock } = sinkWith({}, [429], { "Retry-After": "7" });
    sink.event("a");
    sink.event("b");
    await sink.flush();
    expect(sent.length).toBe(1);
    expect(sink.pending).toBe(2);
    expect([...clock.pending.values()][0].ms).toBe(7000);
    // A full queue does not jump the wait.
    clock.runAll();
    await until(() => sent.length === 2 && sink.pending === 0);
    expect(sent.length).toBe(2);
    expect(sent[1].json.items.map((i: any) => i.name)).toEqual(["a", "b"]);
    expect(sink.pending).toBe(0);
  });

  it("splits a batch the door says is too large", async () => {
    const { sink, sent } = sinkWith({}, [413]);
    for (const n of ["a", "b", "c", "d"]) sink.event(n);
    await sink.flush();
    expect(sent.map((s) => s.json.items.length)).toEqual([4, 2, 2]);
  });

  it("flushes by beacon on pagehide, as text/plain, under the beacon cap", async () => {
    const beacons: Array<{ url: string; blob: Blob }> = [];
    const listeners: Record<string, () => void> = {};
    (globalThis as any).window = { addEventListener: (t: string, fn: () => void) => (listeners[t] = fn), removeEventListener: () => {} };
    const prevNav = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: { sendBeacon: (url: string, blob: Blob) => (beacons.push({ url, blob }), true) },
      configurable: true,
    });
    try {
      const { sink, sent } = sinkWith();
      for (let i = 0; i < 40; i++) sink.event(`e${i}`, { pad: "x".repeat(3000) });
      listeners.pagehide();
      expect(sent.length).toBe(0);
      expect(beacons.length).toBeGreaterThan(1);
      for (const b of beacons) {
        expect(b.url).toBe("https://ingest.test/cli/ingest/cc_ing_abc");
        expect(b.blob.type).toContain("text/plain");
        expect(b.blob.size).toBeLessThan(60 * 1024);
      }
      const names = (await Promise.all(beacons.map(async (b) => JSON.parse(await b.blob.text()).items))).flat().map((i: any) => i.name);
      expect(names.length).toBe(40);
      expect(sink.pending).toBe(0);
      sink.close();
    } finally {
      delete (globalThis as any).window;
      Object.defineProperty(globalThis, "navigator", { value: prevNav, configurable: true });
    }
  });

  it("signs replay chunks against <endpoint>/<key>/replay-sign", async () => {
    // The door's answers (codecast replaysHttp.ts): a URL, or exists with a null URL.
    const answers: any[] = [{ key: "k", upload_url: "https://r2.test/put", exists: false }, { key: "k", upload_url: null, exists: true }, "nope"];
    const calls: Array<{ url: string; body: any }> = [];
    const sink = createCodecastSink({
      ingestKey: "cc_ing_abc",
      endpoint: "https://ingest.test/cli/ingest",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(init.body as string) });
        const a = answers.shift();
        return a === "nope" ? new Response("x", { status: 500 }) : Response.json(a);
      }) as unknown as typeof fetch,
    });
    const chunk = (seq: number) => ({ replay_id: "rp", seq, sha256: "a".repeat(64), size: 100 });
    expect(await sink.signReplayChunk(chunk(0))).toEqual({ upload_url: "https://r2.test/put" });
    expect(await sink.signReplayChunk(chunk(1))).toEqual({ exists: true });
    expect(await sink.signReplayChunk(chunk(2))).toBeNull();
    expect(calls[0]).toEqual({ url: "https://ingest.test/cli/ingest/cc_ing_abc/replay-sign", body: chunk(0) });
    sink.close();
  });
});

describe("status and backoff rules", () => {
  it("classifies door answers", () => {
    expect(classifyStatus(202)).toBe("ok");
    expect(classifyStatus(401)).toBe("stop");
    expect(classifyStatus(400)).toBe("drop");
    expect(classifyStatus(413)).toBe("split");
    expect(classifyStatus(429)).toBe("retry");
    expect(classifyStatus(503)).toBe("retry");
  });

  it("backs off exponentially with jitter, capped at a minute", () => {
    expect(backoffMs(0, null, () => 0)).toBe(500);
    expect(backoffMs(0, null, () => 1)).toBe(1000);
    expect(backoffMs(3, null, () => 1)).toBe(8000);
    expect(backoffMs(20, null, () => 1)).toBe(60_000);
    expect(backoffMs(0, "3")).toBe(3000);
    expect(backoffMs(0, "999")).toBe(60_000);
  });
});
