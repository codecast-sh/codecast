import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks, getUndoHistory, performUndo, undoEntry } from "@platform/engine";
import { useInboxStore } from "../inboxStore";

// B1: archiving a doc deletes the row and plants a `docs:<id>` exclude. The
// undo has to lift that exclude, put the row and its docDetails copy back,
// and tell the server, or the next docs push (a delta channel) skips the
// excluded id and the doc stays gone.
const DOC = "d".repeat(32);
const row = { _id: DOC, title: "Launch notes", doc_type: "note", pinned: true, updated_at: 5 };
const detail = { ...row, content: "# Launch\n\nbody" };

const s = () => useInboxStore.getState() as any;
let calls: Array<[string, unknown[]]> = [];
const owner = {};

beforeAll(() => {
  s()._setDispatch(async (action: string, args: unknown[]) => {
    calls.push([action, args]);
    return null;
  }, { owner });
});
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  _resetUndoStacks();
  calls = [];
  useInboxStore.setState({ docs: { [DOC]: { ...row } }, docDetails: { [DOC]: { ...detail } }, pending: {} } as any);
});

describe("undo of a doc archive", () => {
  it("records one entry with the doc's title, and offers it in a toast", () => {
    s().archiveDoc(DOC);
    expect(s().docs[DOC]).toBeUndefined();
    expect(s().pending[`docs:${DOC}`]).toMatchObject({ type: "exclude" });
    const [entry] = getUndoHistory().items;
    expect(entry!.label).toBe("Archived “Launch notes”");
  });

  it("brings the doc and its detail back, and the next push keeps it with no exclude left", () => {
    s().archiveDoc(DOC);
    calls = [];
    expect(performUndo()).toBe(true);

    expect(s().docs[DOC]).toMatchObject({ _id: DOC, title: "Launch notes", pinned: true });
    expect(s().docDetails[DOC]).toMatchObject({ content: "# Launch\n\nbody" });
    expect(s().pending[`docs:${DOC}`]).not.toMatchObject({ type: "exclude" });
    expect(calls).toContainEqual(["restoreArchivedDoc", [DOC]]);

    // The server's push of the unarchived row lands; nothing excludes it. The
    // replay's include is the one any local add plants on this delta channel,
    // retired by the dispatch's sync-log ack (stampSyncAck), not by a push.
    s().syncTable("docs", [{ ...row, updated_at: 6 }], { isDelta: true });
    expect(s().docs[DOC]).toMatchObject({ _id: DOC, title: "Launch notes" });
    expect(Object.entries(s().pending).filter(([k, e]: [string, any]) => k.startsWith(`docs:${DOC}`) && e.type === "exclude")).toEqual([]);
  });

  it("the toast's Undo takes back the archive it announced", () => {
    s().archiveDoc(DOC);
    const id = getUndoHistory().items[0]!.id;
    expect(undoEntry(id)).toBe(true);
    expect(s().docs[DOC]).toBeDefined();
  });
});
