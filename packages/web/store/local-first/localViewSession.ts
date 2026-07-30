import {
  CompleteViewSource,
  type CompleteViewContract,
} from "./contracts";
import { compareSourceCoverage } from "./coverage";
import { LocalFirstEngine, StaleLocalFirstSourceError } from "./engine";
import { PrincipalStoreFenceError } from "./persistence/adapter";
import { selectVisibleMaterializedView } from "./visibleView";
import type { SourceCoverage } from "./types";

export type LocalViewStatus = "loading" | "granted" | "forbidden" | "missing" | "unknown";

export type LocalViewPublication<TRow> = {
  status: LocalViewStatus;
  rows: readonly { entityKey: string; value: TRow }[];
  activeCommandIds: readonly string[];
  head: number;
};

function isSupersession(error: unknown): boolean {
  return error instanceof StaleLocalFirstSourceError ||
    error instanceof PrincipalStoreFenceError;
}

/**
 * One mounted complete view: durable rows first, then every authorized server
 * result applied in arrival order, republished on each observed commit.
 *
 * This is the imperative core of `useLocalView`, kept React-free so ordering,
 * supersession, and publication behavior are directly testable. Feature code
 * never touches this class; it declares a contract and reads the publication.
 */
export class LocalViewSession<TArgs, TServerResult, TRow> {
  private queue: Promise<CompleteViewSource<TArgs, TServerResult, TRow> | null>;
  private closed = false;
  private readonly viewKey: string;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly engine: LocalFirstEngine,
    private readonly contract: CompleteViewContract<string, TArgs, TServerResult, TRow>,
    private readonly args: TArgs,
    private readonly publish: (publication: LocalViewPublication<TRow>) => void,
  ) {
    this.viewKey = contract.key(args);
    // Durable state paints before any server round-trip; opening the source
    // claims the writer epoch that every later apply is fenced against.
    this.queue = (async () => {
      const source = await CompleteViewSource.open(this.engine, contract, args);
      if (this.closed) {
        source.close();
        return null;
      }
      await this.republish();
      return source;
    })().catch((error) => {
      this.report("open", error);
      return null;
    });
    this.unsubscribe = engine.subscribeCommits(({ affectedKeys }) => {
      if (this.affectsThisView(affectedKeys)) void this.republish().catch(() => {});
    });
  }

  /** Results must be delivered in subscription order; application is FIFO. */
  deliver(serverResult: TServerResult): Promise<void> {
    return this.enqueue(serverResult, undefined);
  }

  /**
   * Delivery from the transition stamper: the result plus the backend log
   * timestamp it is valid at. Required for stamped-log-ts contracts, whose
   * granted coverage is the timestamp rather than anything the envelope says.
   */
  deliverStamped(serverResult: TServerResult, logTs: string): Promise<void> {
    return this.enqueue(serverResult, logTs);
  }

  private enqueue(serverResult: TServerResult, stampedLogTs: string | undefined): Promise<void> {
    this.queue = this.queue.then(async (source) => {
      if (this.closed) return source;
      if (!source) {
        // The initial open failed (a transient storage fault at mount). Each
        // delivery is a fresh chance to open — a dead-until-remount view is
        // never the right outcome for a one-shot fault.
        try {
          source = await CompleteViewSource.open(this.engine, this.contract, this.args);
        } catch (error) {
          this.report("open", error);
          return null;
        }
        if (this.closed) {
          source.close();
          return null;
        }
      }
      try {
        const captured = source.capture();
        await source.apply(captured, serverResult, undefined, { stampedLogTs });
        await this.republish();
        return source;
      } catch (error) {
        if (this.closed ||
          !isSupersession(error) ||
          (error instanceof StaleLocalFirstSourceError && error.reason === "principal")) {
          this.report("apply", error);
          return source;
        }
        // A superseded source cannot recover by itself: its durable writer or
        // source entry now belongs to something that no longer exists — a
        // closed tab that held the writer, a forbidden/missing transition that
        // retired it, or a stale close. When THIS delivery provably advances
        // the durable view (or carries an access transition that must land),
        // hand the view off: claim a fresh writer and re-apply once.
        if (!(await this.shouldReopenFor(serverResult, stampedLogTs))) return source;
        source.close();
        let reopened: CompleteViewSource<TArgs, TServerResult, TRow>;
        try {
          reopened = await CompleteViewSource.open(this.engine, this.contract, this.args);
        } catch (openError) {
          this.report("open", openError);
          return source;
        }
        if (this.closed) {
          reopened.close();
          return null;
        }
        try {
          await reopened.apply(reopened.capture(), serverResult, undefined, { stampedLogTs });
          await this.republish();
        } catch (retryError) {
          this.report("apply", retryError);
        }
        return reopened;
      }
    });
    return this.settled();
  }

  /**
   * Re-open only when this delivery moves the durable view forward. A result
   * whose coverage the durable view already reached must not trigger a claim —
   * otherwise two live tabs would steal the writer from each other on every
   * subscription refire. Non-granted results always qualify: access loss must
   * become durable even if this tab lost the writer race.
   */
  private async shouldReopenFor(
    serverResult: TServerResult,
    stampedLogTs: string | undefined,
  ): Promise<boolean> {
    try {
      const decoded = this.contract.decode(serverResult);
      if (decoded.access === "unavailable" || decoded.access === "unauthenticated") return false;
      if (decoded.access !== "granted") return true;
      const delivered: SourceCoverage =
        this.contract.coverageSource === "stamped-log-ts" && stampedLogTs !== undefined
          ? { kind: "log-ts", ts: stampedLogTs }
          : decoded.coverage;
      const snapshot = await this.engine.readSnapshot();
      const durable = snapshot.views.find((view) => view.key === this.viewKey)?.coverage ??
        snapshot.viewWriters.find((writer) => writer.key === this.viewKey)?.lastCoverage;
      if (!durable) return true;
      const order = compareSourceCoverage(durable, delivered);
      if (order === "newer") return true;
      // Incomparable coverage against a live delivery means the durable view
      // belongs to a predecessor coverage domain (contract migration): the
      // re-open performs the supersession claim, which resets the domain.
      return order === "incomparable" && this.contract.supersedes !== undefined;
    } catch {
      return false;
    }
  }

  /** Resolves when every delivery accepted so far has been applied. */
  async settled(): Promise<void> {
    await this.queue;
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    void this.queue.then((source) => source?.close()).catch(() => {});
  }

  /** Commands, entities, and this view's own records change what is visible. */
  private affectsThisView(affectedKeys: readonly string[]): boolean {
    if (affectedKeys.length === 0) return true;
    return affectedKeys.some((key) =>
      key === `view:${this.viewKey}` ||
      key === `view-access:${this.viewKey}` ||
      key.startsWith(`view-segment:${this.viewKey}`) ||
      key.startsWith("command:") ||
      key.startsWith("receipt:") ||
      key.startsWith("entity:") ||
      key.startsWith("tombstone:"));
  }

  private async republish(): Promise<void> {
    if (this.closed) return;
    const snapshot = await this.engine.readSnapshot();
    if (this.closed) return;
    const visible = selectVisibleMaterializedView(snapshot, this.viewKey);
    const status: LocalViewStatus = visible.view
      ? "granted"
      : snapshot.viewWriters.find((writer) => writer.key === this.viewKey)?.lastAccess ?? "loading";
    this.publish({
      status,
      rows: visible.rows.map((row) => ({ entityKey: row.entityKey, value: row.value as TRow })),
      activeCommandIds: visible.activeCommandIds,
      head: snapshot.metadata.head,
    });
  }

  private report(stage: "open" | "apply", error: unknown): void {
    // Supersession (principal switch, newer source, fenced store) is the
    // successor's story to tell; anything else is surfaced for diagnosis while
    // engine health hooks handle storage degradation.
    if (isSupersession(error)) return;
    console.error(`[local-first] view ${this.viewKey} ${stage} failed`, error);
  }
}
