export function hasActiveCloudWork(statuses: Iterable<string>, activeTurns: number): boolean {
  return activeTurns > 0 || [...statuses].some((status) => status === "working" || status === "thinking");
}
