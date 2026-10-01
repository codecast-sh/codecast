// setInterval that keeps time in a background tab.
//
// A page's own timers are throttled once it is hidden: Chrome runs them about
// once a minute after five minutes in the background, Safari sooner and
// harsher. That is fine for most work and wrong for a lease, where a late
// beat reads to the server as somebody who left and came back (a guest at a
// meeting's door would drop off it and knock again every minute). A
// dedicated worker's timers are not throttled that way, so the worker keeps
// the time and posts to the page, which does the beat. Where there is no
// worker (tests, a browser that refuses one), it is a plain setInterval.

export function steadyInterval(fn: () => void, ms: number): () => void {
  let worker: Worker | null = null;
  let fallback: ReturnType<typeof setInterval> | null = null;
  const plain = () => {
    if (!fallback) fallback = setInterval(fn, ms);
  };
  if (typeof Worker === "undefined") {
    plain();
  } else {
    try {
      // The URL must stay a literal: it is how Vite finds and bundles the worker.
      worker = new Worker(new URL("./steadyInterval.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = () => fn();
      worker.onerror = () => {
        worker?.terminate();
        worker = null;
        plain();
      };
      worker.postMessage({ ms });
    } catch {
      worker = null;
      plain();
    }
  }
  return () => {
    worker?.terminate();
    worker = null;
    if (fallback) clearInterval(fallback);
    fallback = null;
  };
}
