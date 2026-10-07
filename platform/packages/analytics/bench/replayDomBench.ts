// Main-thread cost of the replay recorder, DOM mode on vs off, in a real
// browser. Built to one script and injected into a page (any page: a
// synthetic one, or the app itself), it exposes window.__replayBench:
//
//   bun build bench/replayDomBench.ts --outfile /tmp/replay-bench.js --target browser --format iife --minify
//   cast browser eval --file /tmp/replay-bench.js
//   cast browser eval "await __replayBench.churn({ rows: 2000, iterations: 200 })"
//   cast browser eval "await __replayBench.snapshot()"
//
// churn() times a workload of app-like DOM churn (text updates, class
// toggles, rows added and removed, a click and a keystroke per iteration)
// with no recorder, with the semantic recorder (replayDom off), and with DOM
// mode on, alternating the modes so drift in the machine hits all three. Each
// iteration is timed up to the next task, so rrweb's MutationObserver
// callbacks (microtasks) count against it. snapshot() measures what DOM mode
// costs once: rrweb starting on the current page (its first full snapshot), a
// checkout, and serializing plus gzipping what it held.
//
// The sink is a stand-in that accepts nothing, so nothing leaves the page.

import { startReplay, type DomEvent, type ReplayRecorder } from "../src/replay";
import { startDomRecording } from "../src/replayDom";
import { gzipText, type CodecastSink } from "../src/codecast";

const sink = {
  endpoint: "https://bench.invalid/ingest",
  ingestKey: "cc_ing_bench",
  stopped: false,
  pending: 0,
  onError: () => () => {},
  setReplayId: () => {},
  scrubUrl: (text: string) => text,
  replay: () => {},
  signReplayChunk: async () => null,
  captureError: () => {},
} as unknown as CodecastSink;

type Mode = "none" | "semantic" | "dom";

// The next task: MutationObserver callbacks and every microtask before it have run.
const nextTask = () =>
  new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });

function stage(rows: number): { root: HTMLElement; input: HTMLInputElement; button: HTMLButtonElement } {
  document.getElementById("replay-bench")?.remove();
  const root = document.createElement("div");
  root.id = "replay-bench";
  root.innerHTML = `<input id="rb-input" aria-label="Search"><button id="rb-button">Refresh</button><ul>${Array.from(
    { length: rows },
    (_, i) => `<li class="row" data-i="${i}"><span class="title">Session ${i}</span> <span class="age">${i}s</span> <em>${"w".repeat(i % 40)}</em></li>`,
  ).join("")}</ul>`;
  document.body.appendChild(root);
  return { root, input: root.querySelector("input")!, button: root.querySelector("button")! };
}

function mutateOnce(root: HTMLElement, i: number) {
  const list = root.querySelector("ul")!;
  const items = list.children;
  // 50 ticking timestamps
  for (let k = 0; k < 50; k++) (items[(i * 50 + k) % items.length].querySelector(".age") as HTMLElement).textContent = `${i + k}s`;
  // 20 class toggles
  for (let k = 0; k < 20; k++) items[(i * 7 + k * 13) % items.length].classList.toggle("active");
  // 5 rows in, 5 rows out
  for (let k = 0; k < 5; k++) {
    const li = document.createElement("li");
    li.className = "row";
    li.innerHTML = `<span class="title">New ${i}.${k}</span> <span class="age">0s</span>`;
    list.appendChild(li);
    list.firstElementChild?.remove();
  }
}

function interactOnce(input: HTMLInputElement, button: HTMLButtonElement, i: number) {
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  input.value = `query ${i}`;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const round = (n: number) => Math.round(n * 1000) / 1000;

async function withMode<T>(mode: Mode, fn: (recorder: ReplayRecorder | null) => Promise<T>): Promise<T> {
  if (mode === "none") return fn(null);
  const recorder = startReplay({
    sink,
    sampleRate: 0,
    replayDom: mode === "dom" ? "onError" : "off",
    loadDomRecorder: async () => startDomRecording,
  });
  try {
    if (mode === "dom") while (recorder.domEvents === 0) await nextTask();
    return await fn(recorder);
  } finally {
    recorder.stop();
  }
}

// Layout is settled before every timed step, as a rendered frame would leave
// it, so a step pays for its own work and not a relayout the browser owed
// anyway (a background tab renders no frames between steps).
async function churn({ rows = 2000, iterations = 200, rounds = 3 } = {}) {
  const phases = ["mutations", "interactions"] as const;
  const times: Record<(typeof phases)[number], Record<Mode, number[]>> = {
    mutations: { none: [], semantic: [], dom: [] },
    interactions: { none: [], semantic: [], dom: [] },
  };
  const held: number[] = [];
  let pageNodes = 0;
  for (let r = 0; r < rounds; r++) {
    for (const mode of ["none", "semantic", "dom"] as Mode[]) {
      const { root, input, button } = stage(rows);
      pageNodes = document.getElementsByTagName("*").length;
      await nextTask();
      await withMode(mode, async (recorder) => {
        for (let i = 0; i < iterations; i++) {
          for (const phase of phases) {
            void document.body.offsetHeight;
            const t0 = performance.now();
            if (phase === "mutations") mutateOnce(root, i);
            else interactOnce(input, button, i);
            await nextTask();
            times[phase][mode].push(performance.now() - t0);
          }
        }
        if (mode === "dom" && recorder) held.push(recorder.domEvents);
      });
      root.remove();
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const summary = (xs: number[]) => ({ mean_ms: round(mean(xs)), p50_ms: round(pct(xs, 50)), p95_ms: round(pct(xs, 95)), max_ms: round(Math.max(...xs)) });
  const per = (phase: (typeof phases)[number]) => ({
    none: summary(times[phase].none),
    semantic: summary(times[phase].semantic),
    dom: summary(times[phase].dom),
    semantic_overhead_ms: round(mean(times[phase].semantic) - mean(times[phase].none)),
    dom_overhead_ms: round(mean(times[phase].dom) - mean(times[phase].semantic)),
  });
  return { rows, iterations, rounds, page_nodes: pageNodes, mutations: per("mutations"), interactions: per("interactions"), dom_events_held: held };
}

async function snapshot() {
  const events: DomEvent[] = [];
  const t0 = performance.now();
  const rec = startDomRecording((e) => events.push(e));
  const start_ms = performance.now() - t0;
  if (!rec) return { error: "rrweb did not start" };
  const t1 = performance.now();
  rec.checkout();
  const checkout_ms = performance.now() - t1;
  rec.stop();
  const t2 = performance.now();
  const text = `[${events.map((e) => JSON.stringify(e)).join(",")}]`;
  const stringify_ms = performance.now() - t2;
  const t3 = performance.now();
  const gz = await gzipText(text);
  const gzip_ms = performance.now() - t3;
  return {
    page_nodes: document.getElementsByTagName("*").length,
    start_ms: round(start_ms),
    checkout_ms: round(checkout_ms),
    events: events.length,
    json_bytes_two_snapshots: text.length,
    gzip_bytes_two_snapshots: gz?.byteLength ?? null,
    stringify_ms: round(stringify_ms),
    gzip_ms_async: round(gzip_ms),
  };
}

(globalThis as { __replayBench?: unknown }).__replayBench = { churn, snapshot };
