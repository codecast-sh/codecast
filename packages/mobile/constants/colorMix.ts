/** `a` mixed with `b`, `pct` percent of `a`, as hex: CSS color-mix in srgb. */
export function mixHex(a: string, pct: number, b: string): string {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return '#' + x.map((v, i) => Math.round((v * pct + y[i] * (100 - pct)) / 100).toString(16).padStart(2, '0')).join('');
}
