import {
  CompleteViewSource,
  type CompleteViewContract,
} from "./contracts";
import { LocalFirstEngine, StaleLocalFirstSourceError } from "./engine";
import { PrincipalStoreFenceError } from "./persistence/adapter";
import { selectVisibleMaterializedView } from "./visibleView";

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
    contract: CompleteViewContract<string, TArgs, TServerResult, TRow>,
    args: TArgs,
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
    this.queue = this.queue.then(async (source) => {
      if (!source || this.closed) return source;
      try {
        const captured = source.capture();
        await source.apply(captured, serverResult);
        await this.republish();
      } catch (error) {
        this.report("apply", error);
      }
      return source;
    });
    return this.settled();
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
