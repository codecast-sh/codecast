import type { PrincipalStoreSnapshot } from "./persistence/adapter";
import { selectVisibleMaterializedView, type VisibleViewRow } from "./visibleView";

export type MaterializedPublication = {
  contractId: string;
  viewKey: string;
  access: "granted" | "forbidden" | "missing" | "unknown";
  rows: readonly VisibleViewRow[];
  activeCommandIds: readonly string[];
  head: number;
};

export type MaterializedViewPublisher = {
  contractId: string;
  matches(viewKey: string): boolean;
  publish(publication: MaterializedPublication): void;
};

function accessForView(snapshot: PrincipalStoreSnapshot, viewKey: string): MaterializedPublication["access"] {
  if (snapshot.views.some((view) => view.key === viewKey)) return "granted";
  return snapshot.viewWriters.find((writer) => writer.key === viewKey)?.lastAccess ?? "unknown";
}

/**
 * Registry outside the engine: a new feature view declares how its already
 * durable visible rows enter a reactive UI store, while persistence/apply
 * semantics remain generic and branch-free.
 */
export class MaterializedPublicationRegistry {
  private readonly publishers = new Map<string, MaterializedViewPublisher>();

  register(publisher: MaterializedViewPublisher): () => void {
    if (this.publishers.has(publisher.contractId)) {
      throw new Error(`Materialized publisher already registered: ${publisher.contractId}`);
    }
    this.publishers.set(publisher.contractId, publisher);
    return () => {
      if (this.publishers.get(publisher.contractId) === publisher) {
        this.publishers.delete(publisher.contractId);
      }
    };
  }

  publish(snapshot: PrincipalStoreSnapshot, contractId: string, viewKey: string): boolean {
    const publisher = this.publishers.get(contractId);
    if (!publisher || !publisher.matches(viewKey)) return false;
    const durableContracts = new Set([
      ...snapshot.views.filter((view) => view.key === viewKey).map((view) => view.contractId),
      ...snapshot.viewWriters.filter((writer) => writer.key === viewKey).map((writer) => writer.contractId),
    ]);
    if (durableContracts.size === 0) return false;
    if (durableContracts.size !== 1 || !durableContracts.has(contractId)) {
      throw new Error(`Durable view identity does not match publisher: ${contractId}/${viewKey}`);
    }
    const visible = selectVisibleMaterializedView(snapshot, viewKey);
    publisher.publish({
      contractId,
      viewKey,
      access: accessForView(snapshot, viewKey),
      rows: visible.rows,
      activeCommandIds: visible.activeCommandIds,
      head: snapshot.metadata.head,
    });
    return true;
  }

  publishKnownViews(snapshot: PrincipalStoreSnapshot): string[] {
    const candidates = new Map<string, string>();
    for (const view of snapshot.views) candidates.set(view.key, view.contractId);
    for (const writer of snapshot.viewWriters) candidates.set(writer.key, writer.contractId);
    const published: string[] = [];
    for (const [viewKey, contractId] of candidates) {
      if (this.publish(snapshot, contractId, viewKey)) published.push(viewKey);
    }
    return published.sort();
  }
}
