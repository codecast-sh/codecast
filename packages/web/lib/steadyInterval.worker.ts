// The clock behind steadyInterval: a worker's timers are not slowed the way a
// hidden page's are, so it ticks on time and the page does the work.
// Messages: { ms } starts (or restarts) the tick; { stop: true } stops it.
let timer: ReturnType<typeof setInterval> | null = null;

self.onmessage = (e: MessageEvent<{ ms?: number; stop?: boolean }>) => {
  if (timer) clearInterval(timer);
  timer = null;
  if (e.data.stop || !e.data.ms) return;
  timer = setInterval(() => (self as unknown as Worker).postMessage(0), e.data.ms);
};
