// STUB for ct-96177's worktree only: ct-96176 (jx77wcg) owns this file and
// lands the real one. Same signatures; drop this copy when theirs is present.
export type MetricNoise = { kind: "poisson" } | { kind: "binomial"; n?: number; series?: string } | { kind: "aa"; sd: number };

export function parseMetricNoise(spec?: string | null): MetricNoise | null {
  const s = (spec ?? "").trim().toLowerCase();
  if (s === "poisson") return { kind: "poisson" };
  const bin = s.match(/^binomial(?::(\S+))?$/);
  if (bin) {
    const arg = bin[1];
    if (!arg) return { kind: "binomial" };
    return /^mw-\d+$/.test(arg) ? { kind: "binomial", series: arg } : Number(arg) > 0 ? { kind: "binomial", n: Number(arg) } : null;
  }
  const aa = s.match(/^aa:(\d+(?:\.\d+)?)$/);
  return aa && Number(aa[1]) > 0 ? { kind: "aa", sd: Number(aa[1]) } : null;
}

export function noiseSd(value: number, noise?: string | null, n?: number | null): number | null {
  const m = parseMetricNoise(noise);
  if (!m || !Number.isFinite(value)) return null;
  if (m.kind === "poisson") return Math.sqrt(Math.max(0, value));
  if (m.kind === "aa") return m.sd;
  const size = m.n ?? n ?? null;
  if (!size) return null;
  const scale = value > 1 ? 100 : 1;
  const p = Math.min(1, Math.max(0, value / scale));
  return Math.sqrt((p * (1 - p)) / size) * scale;
}
