import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Window } from "happy-dom";
import { sha256Hex, type CodecastErrorItem, type CodecastReplayManifest, type CodecastSink, type ReplayChunkSign, type ReplaySignResult } from "./codecast";
import { cleanUrl, labelOf, startReplay, visibleOutline, REPLAY_LIMITS, type ReplayEvent, type ReplayRecorder } from "./replay";

// A real DOM for the recorder, installed as the globals it reads.
let win: Window;
let recorder: ReplayRecorder | null = null;
const saved: Record<string, unknown> = {};
const GLOBALS = ["window", "document", "history", "location", "XMLHttpRequest", "CSS"] as const;
let clock = 0;
const timers: Array<{ fn: () => void; ms: number }> = [];

function fakeSink(sign: (chunk: number) => ReplaySignResult | null = () => ({ upload_url: `https://r2.test/chunk` })) {
  const listeners = new Set<(item: CodecastErrorItem) => void>();
  const manifests: CodecastReplayManifest[] = [];
  const signs: ReplayChunkSign[] = [];
  let replayId: string | undefined;
  const sink = {
    endpoint: "https://ingest.test/cli/ingest",
    ingestKey: "cc_ing_x",
    stopped: false,
    pending: 0,
    onError: (fn: (item: CodecastErrorItem) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setReplayId: (id: string | undefined) => {
      replayId = id;
    },
    // The app's secret paths (config.scrubUrl): a link that is a key.
    scrubUrl: (text: string) => text.replace(/\/meet\/[^/?#]+/g, "/meet/:token"),
    replay: (m: CodecastReplayManifest) => manifests.push(m),
    signReplayChunk: async (chunk: ReplayChunkSign) => {
      signs.push(chunk);
      return sign(chunk.seq);
    },
    captureError: (error: unknown) => {
      const item: CodecastErrorItem = { type: "error", message: (error as Error).message, stack: (error as Error).stack, at: clock };
      for (const l of listeners) l(item);
    },
  } as unknown as CodecastSink;
  return { sink, manifests, signs, replayId: () => replayId };
}

const puts: Array<{ url: string; body: any; sha256: string; size: number; headers: unknown }> = [];
const uploadFetch = (async (url: string, init: RequestInit) => {
  const bytes = init.body as Uint8Array<ArrayBuffer>;
  const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = gz
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
    : new TextDecoder().decode(bytes);
  puts.push({ url, body: JSON.parse(text), sha256: await sha256Hex(bytes), size: bytes.byteLength, headers: init.headers });
  return new Response(null, { status: 200 });
}) as unknown as typeof fetch;

// The page's own fetch, which the recorder wraps.
let pageAnswers: Array<{ status: number; delay?: number }> = [];
const pageFetch = (async () => {
  const a = pageAnswers.shift() ?? { status: 200 };
  clock += a.delay ?? 10;
  if (a.status === 0) throw new TypeError("Failed to fetch");
  return new Response("x", { status: a.status });
}) as unknown as typeof fetch;

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

function start(opts: Partial<Parameters<typeof startReplay>[0]> = {}, sink = fakeSink()) {
  recorder = startReplay({
    sink: sink.sink,
    now: () => clock,
    random: () => 0.5,
    fetch: uploadFetch,
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => {},
    ...opts,
  });
  return { recorder, ...sink };
}

const types = (events: readonly ReplayEvent[]) => events.map((e) => e.type);

beforeEach(() => {
  win = new Window({ url: "https://app.test/start?token=secret" });
  for (const k of GLOBALS) {
    saved[k] = (globalThis as any)[k];
    (globalThis as any)[k] = k === "window" ? win : (win as any)[k];
  }
  saved.fetch = globalThis.fetch;
  globalThis.fetch = pageFetch;
  clock = 1_000;
  timers.length = 0;
  puts.length = 0;
  pageAnswers = [];
  win.document.title = "Start";
  win.document.body.innerHTML = `
    <h1>Checkout</h1>
    <p>Your cart has <b>2</b> items.</p>
    <form aria-label="Payment" id="pay">
      <label for="card">Card number</label>
      <input id="card" name="card" type="text" />
      <label>Email <input name="email" type="email" /></label>
      <textarea name="note">prefilled note</textarea>
      <button type="submit">Pay now</button>
    </form>
    <div data-private><button id="secret">Account 12345</button><p>Balance 999</p></div>
    <div hidden><p>Invisible</p></div>
    <a href="/help" data-testid="help-link">Help</a>
  `;
});

afterEach(() => {
  recorder?.stop();
  recorder = null;
  for (const k of GLOBALS) (globalThis as any)[k] = saved[k];
  globalThis.fetch = saved.fetch as typeof fetch;
  win.close();
});

describe("labels and outline", () => {
  it("names elements the way a person would, never from a value", () => {
    const doc = win.document;
    const card = doc.getElementById("card") as unknown as HTMLInputElement;
    card.value = "4242 4242";
    expect(labelOf(card as unknown as Element)).toBe("Card number");
    expect(labelOf(doc.querySelector("input[name=email]") as unknown as Element)).toBe("Email");
    expect(labelOf(doc.querySelector("button[type=submit]") as unknown as Element)).toBe("Pay now");
    expect(labelOf(doc.getElementById("secret") as unknown as Element)).toBe("[private]");
    expect(labelOf(doc.querySelector("form") as unknown as Element)).toBe("Payment");
  });

  it("outlines visible text, skipping fields, private and hidden parts, within the cap", () => {
    const outline = visibleOutline(win.document.body as unknown as Element);
    expect(outline).toContain("# Checkout");
    expect(outline).toContain("[button] Pay now");
    expect(outline).toContain("[link] Help");
    expect(outline).toContain("Your cart has");
    expect(outline).not.toContain("prefilled note");
    expect(outline).not.toContain("Balance");
    expect(outline).not.toContain("Account 12345");
    expect(outline).not.toContain("Invisible");
    win.document.body.innerHTML = `<p>${"word ".repeat(5000)}</p>`;
    expect(visibleOutline(win.document.body as unknown as Element).length).toBeLessThanOrEqual(REPLAY_LIMITS.view_outline_max_chars);
  });

  it("never reads text out of a rich text editor, or a container holding one", () => {
    const doc = win.document;
    doc.body.innerHTML = `
      <h2>Notes</h2>
      <div id="card"><div contenteditable="true" id="editor"><p id="para">typed secret <b id="bold">words</b></p></div></div>
      <div contenteditable="plaintext-only" aria-label="Comment">plain secret</div>
      <div contenteditable="false"><p>static copy</p></div>
      <h3>Title <span data-private>hidden name</span></h3>
      <button>Save <span contenteditable>inline secret</span></button>
    `;
    const el = (id: string) => doc.getElementById(id) as unknown as Element;
    for (const id of ["editor", "para", "bold", "card"]) expect(labelOf(el(id))).not.toContain("secret");
    expect(labelOf(doc.querySelector("[aria-label=Comment]") as unknown as Element)).toBe("Comment");
    expect(labelOf(doc.querySelector("button") as unknown as Element)).toBe("button");
    const outline = visibleOutline(doc.body as unknown as Element);
    expect(outline).toContain("## Notes");
    expect(outline).toContain("static copy");
    expect(outline).not.toContain("secret");
    expect(outline).not.toContain("words");
    expect(outline).not.toContain("hidden name");
  });

  it("keeps query keys and drops their values", () => {
    expect(cleanUrl("https://a.test/x?token=abc&page=2#frag")).toBe("https://a.test/x?token=&page=#");
  });
});

describe("startReplay", () => {
  it("records nav, clicks, typed lengths, submits and keys, never a value", () => {
    const { recorder: r, replayId } = start();
    expect(replayId()).toBe(r.replayId);
    const doc = win.document;
    const card = doc.getElementById("card")!;
    (card as any).value = "4242424242424242";
    card.dispatchEvent(new win.Event("input", { bubbles: true }));
    (card as any).value = "42424242424242424";
    card.dispatchEvent(new win.Event("input", { bubbles: true }));
    doc.querySelector("button[type=submit]")!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    // The submit button's click submits the form, as in a browser.
    doc.body.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    doc.body.dispatchEvent(new win.KeyboardEvent("keydown", { key: "a", bubbles: true }));

    const events = r.events;
    expect(types(events)).toEqual(["nav", "input", "click", "submit", "key"]);
    expect(events[0]).toMatchObject({ type: "nav", url: "https://app.test/start?token=", title: "Start" });
    expect(events[1]).toMatchObject({ type: "input", label: "Card number", selector: "input#card", length: 17, redacted: true });
    expect(events[2]).toMatchObject({ type: "click", label: "Pay now", role: "button" });
    expect(events[3]).toMatchObject({ type: "submit", label: "Payment", selector: "form#pay" });
    expect(JSON.stringify(events)).not.toContain("4242");
  });

  it("names a page whose address is a key by its shape, never the key", () => {
    const { recorder: r } = start();
    win.history.pushState({}, "", "/meet/k3yk3y?x=1");
    expect(r.events.at(-1)).toMatchObject({ type: "nav", url: "https://app.test/meet/:token?x=" });
    expect(JSON.stringify(r.events)).not.toContain("k3yk3y");
  });

  it("records pushState navigation and takes an outline after it settles", () => {
    const { recorder: r } = start();
    win.history.pushState({}, "", "/orders/7?sort=asc");
    expect(r.events.at(-1)).toMatchObject({ type: "nav", url: "https://app.test/orders/7?sort=" });
    const outlineTimer = timers.at(-1)!;
    expect(outlineTimer.ms).toBe(500);
    outlineTimer.fn();
    expect(r.events.at(-1)?.type).toBe("view");
  });

  it("records console warnings and errors and passes them through", () => {
    const seen: unknown[] = [];
    const prevWarn = console.warn;
    console.warn = (...a: unknown[]) => void seen.push(a);
    try {
      const { recorder: r } = start();
      console.warn("careful", { n: 1 });
      expect(r.events.at(-1)).toMatchObject({ type: "console", level: "warn", message: 'careful {"n":1}' });
      expect(seen.length).toBe(1);
      r.stop();
      expect(console.warn).not.toBe(prevWarn); // our stub is back, not the recorder
      console.warn("after");
      expect(seen.length).toBe(2);
    } finally {
      console.warn = prevWarn;
    }
  });

  it("records failed and slow requests only, and never its own", async () => {
    const { recorder: r } = start();
    pageAnswers = [{ status: 200 }, { status: 500 }, { status: 200, delay: 2500 }, { status: 0 }];
    await fetch("/api/ok");
    await fetch("https://api.test/fail?key=1", { method: "post" });
    await fetch("/api/slow");
    await fetch("/api/down").catch(() => {});
    await fetch("https://ingest.test/cli/ingest/cc_ing_x");
    const net = r.events.filter((e) => e.type === "network");
    expect(net).toEqual([
      expect.objectContaining({ method: "POST", url: "https://api.test/fail?key=", status: 500 }),
      expect.objectContaining({ url: "https://app.test/api/slow", status: 200, ms: 2500 }),
      expect.objectContaining({ url: "https://app.test/api/down", status: 0 }),
    ]);
  });

  it("drops what redactUrl names", async () => {
    const { recorder: r } = start({ redactUrl: /\/admin/ });
    pageAnswers = [{ status: 500 }];
    await fetch("/admin/users");
    win.history.pushState({}, "", "/admin");
    expect(types(r.events)).toEqual(["nav"]);
  });

  it("keeps only the last 60 seconds until something keeps the recording", () => {
    const { recorder: r } = start();
    r.mark("old");
    clock += 61_000;
    r.mark("new");
    expect(r.events.map((e) => (e.type === "mark" ? e.name : e.type))).toEqual(["new"]);
    expect(r.kept).toBe(false);
  });

  it("uploads the buffer on an error: outline, error, chunk PUT, then a manifest", async () => {
    const fake = fakeSink();
    const { recorder: r, manifests, signs } = start({}, fake);
    r.mark("checkout");
    fake.sink.captureError(new Error("payment failed"));
    await until(() => manifests.length === 1);
    expect(r.kept).toBe(true);
    expect(puts.length).toBe(1);
    // Signed for the exact bytes PUT, which carry no Content-Encoding.
    expect(signs[0]).toEqual({ replay_id: r.replayId, seq: 0, sha256: puts[0].sha256, size: puts[0].size });
    expect(puts[0].headers).toBeUndefined();
    expect(puts[0].url).toBe("https://r2.test/chunk");
    expect(types(puts[0].body)).toEqual(["nav", "mark", "view", "error"]);
    expect(puts[0].body.at(-1)).toMatchObject({ message: "payment failed" });
    expect(manifests[0]).toMatchObject({ replay_id: r.replayId, url: "https://app.test/start?token=", chunks: 1, counts: { errors: 1 } });
    expect(r.events.length).toBe(0);
    // A kept recording ships what follows on a timer.
    r.mark("after");
    timers.find((t) => t.ms === 10_000)!.fn();
    await until(() => manifests.length === 2);
    expect(puts.length).toBe(2);
    expect(signs[1].seq).toBe(1);
    expect(manifests.at(-1)?.chunks).toBe(2);
  });

  it("does not upload a sampled-out session without an error, and does from the start when sampled in", () => {
    const out = start({ sampleRate: 0 });
    expect(out.recorder.kept).toBe(false);
    out.recorder.stop();
    const inn = start({ sampleRate: 1 });
    expect(inn.recorder.kept).toBe(true);
    expect(timers.some((t) => t.ms === 10_000)).toBe(true);
  });

  it("records a click inside an editor without what was typed", () => {
    win.document.body.innerHTML = `<div class="card"><div contenteditable="true"><p id="para">my private draft</p></div></div>`;
    const { recorder: r } = start();
    win.document.getElementById("para")!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(r.events.at(-1)).toMatchObject({ type: "click", label: "p" });
    expect(JSON.stringify(r.events)).not.toContain("draft");
  });

  it("goes back to the ring once a recording has used every chunk", async () => {
    const fake = fakeSink();
    const { recorder: r, manifests } = start({ sampleRate: 1 }, fake);
    for (let i = 0; i < REPLAY_LIMITS.max_chunks_per_replay; i++) {
      r.mark(`m${i}`);
      await r.upload();
    }
    expect(manifests.at(-1)?.chunks).toBe(REPLAY_LIMITS.max_chunks_per_replay);
    expect(r.kept).toBe(false);
    // Past the cap the buffer is the 60 s ring again, whatever comes in.
    r.mark("old");
    clock += 61_000;
    r.mark("new");
    expect(r.events.map((e) => (e.type === "mark" ? e.name : e.type))).toEqual(["new"]);
    // A later error cannot keep it again: there is nowhere to send it.
    fake.sink.captureError(new Error("late"));
    await r.upload();
    expect(r.kept).toBe(false);
    expect(puts.length).toBe(REPLAY_LIMITS.max_chunks_per_replay);
  });

  it("falls back to the ring when the door keeps refusing", async () => {
    const fake = fakeSink(() => null);
    const { recorder: r } = start({}, fake);
    for (let i = 0; i < 3; i++) {
      await r.upload();
    }
    expect(r.kept).toBe(false);
    expect(puts.length).toBe(0);
  });

  it("stop restores every patch", () => {
    const pushState = win.history.pushState;
    const { recorder: r } = start();
    expect(win.history.pushState).not.toBe(pushState);
    expect(globalThis.fetch).not.toBe(pageFetch);
    r.stop();
    expect(win.history.pushState).toBe(pushState);
    expect(globalThis.fetch).toBe(pageFetch);
  });
});
