// useShared's updater form, as a pure loop: apply the updater to the value as
// last seen, ask the backend to write it only if nobody wrote since (base
// rev), and on a conflict run the updater again on the value the backend
// answered with. Kept apart from the SDK so the conflict path is testable.
import type { SetSharedResult } from "../convex/runtime";

export type SharedState = { value: unknown; rev: number } | null;

export async function updateShared<T>(
  current: SharedState,
  initial: T,
  update: (prev: T) => T,
  write: (value: T, baseRev: number) => Promise<SetSharedResult>,
  attempts: number,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = update(current ? (current.value as T) : initial);
    const result = await write(value, current?.rev ?? 0);
    if (result.ok) return value;
    current = result.rev === 0 ? null : { value: result.value, rev: result.rev };
  }
  throw new Error("Too many people are changing this at once. Try again.");
}
