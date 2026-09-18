/**
 * The page that keeps the bridge's service worker running.
 *
 * A service worker on its own is the one kind of extension code Chrome
 * treats as disposable: it ends the worker after 30 s without an event, and
 * it puts a process that hosts nothing but a worker in the throttled
 * background tier, where macOS gives it almost no CPU on a busy machine
 * (measured 2026-09-17: the worker's process at priority 4, runnable, 0.6 s
 * of CPU in 25 minutes, its 20 s keepalive timer silent for five minutes at
 * a time; an extension with a document in its process sat at priority 47 in
 * the same Chrome and answered at once). An offscreen document is a page:
 * Chrome does not idle it out, and its timers run. One message every 20 s
 * is an event for the worker, so the worker's idle clock never runs down,
 * and if Chrome did end the worker, the message starts a new one.
 */
const BEAT_MS = 20_000;

function beat() {
  // A worker that is restarting rejects the send; the next beat starts it.
  chrome.runtime.sendMessage({ op: "keeper-beat" }).catch(() => {});
}

setInterval(beat, BEAT_MS);
beat();
