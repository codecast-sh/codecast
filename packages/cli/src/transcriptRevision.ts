import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_LEASE_SIZE = 100_000;
const REVISION_SCALE = 1_000;

type PersistedRevisionLease = {
  next_unallocated: number;
};

/**
 * A crash-safe monotonic clock for transcript mutations.
 *
 * Revisions are compared only within one stable device id. Reserving a range
 * durably before using it means a daemon restart always jumps past every value
 * the previous process could have emitted, without writing to disk per message.
 */
export class TranscriptRevisionClock {
  private nextValue: number;
  private reservedUntil: number;

  constructor(
    private readonly statePath: string,
    private readonly now: () => number = Date.now,
    private readonly leaseSize: number = DEFAULT_LEASE_SIZE,
  ) {
    const persisted = this.readPersistedNext();
    this.nextValue = Math.max(persisted, this.now() * REVISION_SCALE);
    this.reservedUntil = persisted;
  }

  next(): number {
    if (this.nextValue >= this.reservedUntil) {
      const start = Math.max(this.nextValue, this.now() * REVISION_SCALE);
      const nextUnallocated = start + this.leaseSize;
      this.persistNextUnallocated(nextUnallocated);
      this.nextValue = start;
      this.reservedUntil = nextUnallocated;
    }
    return this.nextValue++;
  }

  private readPersistedNext(): number {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as PersistedRevisionLease;
      return Number.isSafeInteger(parsed.next_unallocated) && parsed.next_unallocated >= 0
        ? parsed.next_unallocated
        : 0;
    } catch {
      return 0;
    }
  }

  private persistNextUnallocated(nextUnallocated: number): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ next_unallocated: nextUnallocated }), {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.statePath);
    try {
      fs.chmodSync(this.statePath, 0o600);
    } catch {}
  }
}

let defaultClock: TranscriptRevisionClock | null = null;

export function nextTranscriptSourceRevision(): number {
  if (!defaultClock) {
    defaultClock = new TranscriptRevisionClock(
      path.join(os.homedir(), ".codecast", "transcript-revision.json"),
    );
  }
  return defaultClock.next();
}
