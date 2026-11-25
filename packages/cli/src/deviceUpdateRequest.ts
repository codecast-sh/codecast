// The device row's update request (Settings > Daemon's Update, `cast devices
// update`) as this daemon answers it; convex/lib/deviceUpdate.ts keeps the
// row. The daemon's release check answers from a cache up to a day old, so
// its "nothing newer" can predate the release a request is about. Each
// request gets a manifest read of its own, and every beat names the newest
// request one answered (`update_checked_for`): the server takes "nothing
// newer" as the answer only to a request named there.

export interface UpdateRequestDaemon {
  /** The newer release this daemon's last check found, or null. */
  available(): string | null;
  /** Reads the release manifest now, past the cache. False when no read happened (a check already running, a failed fetch). */
  checkNow(): Promise<boolean>;
  /** Starts the update that answers request `at`. */
  update(at: number): void;
}

export class UpdateRequestAnswerer {
  /** The newest request a manifest read answered: every beat's `update_checked_for`. */
  checkedFor = 0;
  private checking = false;

  constructor(private readonly daemon: UpdateRequestDaemon) {}

  /** A beat's reply carried request `at`, and no update run answers it yet. */
  async ask(at: number): Promise<void> {
    if (this.daemon.available()) return this.daemon.update(at);
    if (this.checking || this.checkedFor >= at) return;
    this.checking = true;
    const read = await this.daemon.checkNow().catch(() => false);
    this.checking = false;
    // Unread, the request stays open on the row and the next beat asks again.
    if (!read) return;
    this.checkedFor = Math.max(this.checkedFor, at);
    if (this.daemon.available()) this.daemon.update(at);
  }
}
