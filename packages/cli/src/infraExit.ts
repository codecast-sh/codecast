// Exit codes for "the tool failed", kept apart from a command's own verdict; ported from pandora/exits.py (MIT).
export const EXIT_INFRA = 70;
export const EXIT_BUSY = 75;
export const EXIT_WAIT_ELAPSED = 124;
export const EXIT_CANCELLED = 130;
export const INFRA_EXIT_CODES: readonly number[] = [EXIT_INFRA, EXIT_BUSY, EXIT_WAIT_ELAPSED, EXIT_CANCELLED];
export const isInfraExit = (code: number | null | undefined) => code != null && INFRA_EXIT_CODES.includes(code);
export const formatHint = (next: string) => `cast: hint: ${next}`;
export function printHint(next: string, stream: { write(s: string): unknown } = process.stderr): void {
  stream.write(`${formatHint(next)}\n`);
}
