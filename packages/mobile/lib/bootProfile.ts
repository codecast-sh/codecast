// Boot-to-first-paint marks. `performance.now()` is ms since JS runtime start
// on Hermes, which is the number we care about (native splash is already up).
const origin =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function bootMark(name: string, extra?: Record<string, unknown>): number {
  const ms = Math.round(now() - origin);
  if (extra && Object.keys(extra).length > 0) {
    console.log(`[boot] ${ms}ms ${name}`, extra);
  } else {
    console.log(`[boot] ${ms}ms ${name}`);
  }
  return ms;
}
