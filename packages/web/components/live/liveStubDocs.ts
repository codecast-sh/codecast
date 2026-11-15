// A board, sheet or dashboard made here opens at once on a placeholder doc (lib/createLiveArtifact). Its
// writes wait in this tab's store under the placeholder id (sendLiveOps paints, sends nothing). Once the
// server has made the doc, the placeholder's elements go out under the real id, the placeholder's rows
// leave the store, and a page showing the placeholder moves to the real doc's address.
//
// The real id arrives one of two ways: the create's own answer (createLiveArtifact calls promoteStubDoc),
// or, after a reload lost that answer, the docs row the server made carrying the placeholder as its
// client_key (watchStubDocs finds it).
import { fromElement, type ArtifactOp } from "@codecast/shared/artifacts";
import { useInboxStore } from "../../store/inboxStore";
import type { LiveLayer } from "../../store/liveArtifactsSlice";
import { routerNavigate } from "../../lib/tabRoutes";
import { docRows, sendLiveOps } from "./useLiveArtifact";
import { isStubDoc } from "./liveStub";

const promoted = new Set<string>();

/** Send a placeholder doc's elements under the real doc, drop the placeholder, and move a page showing it. */
export function promoteStubDoc(stubId: string, realId: string): void {
  if (!isStubDoc(stubId) || isStubDoc(realId) || promoted.has(stubId)) return;
  promoted.add(stubId);
  waiting.delete(stubId);
  const rows = docRows(stubId);
  const batches: Array<[LiveLayer, ArtifactOp[]]> = [];
  for (const layer of ["main", "comments"] as const) {
    const ops: ArtifactOp[] = [];
    for (const row of rows[layer].values()) {
      const state = fromElement(row);
      if (!state.deleted) ops.push({ k: row.key, put: { kind: state.kind, ...state.fields } as any });
    }
    if (ops.length) batches.push([layer, ops]);
  }
  const store = useInboxStore.getState() as any;
  store.liveDropStub(stubId);
  for (const [layer, ops] of batches) sendLiveOps(realId, layer, ops);
  if (typeof window !== "undefined" && window.location.pathname === `/docs/${stubId}`) {
    routerNavigate(`/docs/${realId}${window.location.search}`, "replace");
  }
}

// After a reload the create's answer is gone: the docs row the server made names the placeholder as its
// client_key. Placeholders are known from one look at the cached elements once they have loaded, and from
// each create made here; only while one is waiting does a docs change cost a look.
const waiting = new Set<string>();
let scanned = false;
let watching = false;

/** A placeholder this tab just made: watched until its doc arrives. */
export function noteStubDoc(stubId: string): void {
  if (isStubDoc(stubId) && !promoted.has(stubId)) waiting.add(stubId);
  watchStubDocs();
}

export function watchStubDocs(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  let lastDocs: unknown = null;
  useInboxStore.subscribe((s: any) => {
    if (!scanned && s.liveElements && Object.keys(s.liveElements).length) {
      scanned = true;
      for (const id in s.liveElements) {
        const doc = s.liveElements[id]?.doc_id;
        if (doc && isStubDoc(doc) && !promoted.has(doc)) waiting.add(doc);
      }
    }
    if (waiting.size === 0 || s.docs === lastDocs) return;
    lastDocs = s.docs;
    for (const row of Object.values<any>(s.docs ?? {})) {
      const key = row?.client_key;
      if (typeof key === "string" && waiting.has(key) && !isStubDoc(String(row._id))) {
        waiting.delete(key);
        promoteStubDoc(key, String(row._id));
      }
    }
  });
}

// Watch from the moment any page that can show or make an artifact loads this module.
watchStubDocs();
