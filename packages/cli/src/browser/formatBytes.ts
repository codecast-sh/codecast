/** A byte count as a terminal shows it (512B, 40K, 3M, 1.2G). A leaf, so screenshot writers do not load the profile cloner for it. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}
