import { beforeEach, describe, expect, test } from "bun:test";
import { toast } from "sonner";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import "../undoStack";

// B4: a toast's Undo takes back the change it announced, even after newer
// changes were recorded on top of it. The toasts are read from sonner's own
// history, so this exercises the notifier codecast installs.
const A = "a".repeat(32);
const B = "b".repeat(32);

type Shown = { title?: unknown; action?: { label?: unknown; onClick?: (e: any) => void } };
const undoToastFor = (title: string) =>
  (toast.getHistory() as Shown[]).filter((t) => t.title === title && (t.action as any)?.label === "Undo").at(-1);

describe("an undo toast targets its own entry", () => {
  beforeEach(() => {
    _resetUndoStacks();
    useInboxStore.setState({
      pending: {},
      currentSessionId: null,
      clientState: {},
      sessions: { [A]: { _id: A, title: "First", updated_at: 1 }, [B]: { _id: B, title: "Second", updated_at: 1 } },
      conversations: { [A]: { _id: A, title: "First" }, [B]: { _id: B, title: "Second" } },
    } as any);
  });

  test("the stash toast undoes the stash, not the newer rename", () => {
    useInboxStore.getState().stashSession(A);
    const stashToast = undoToastFor("Stashed “First”");
    expect(stashToast).toBeDefined();

    useInboxStore.getState().renameSession(B, "Renamed");
    expect(getUndoHistory().items).toHaveLength(2);

    stashToast!.action!.onClick!({ preventDefault() {} });
    const sessions = useInboxStore.getState().sessions as any;
    expect(sessions[A].inbox_stashed_at ?? null).toBe(null);
    // The newer change is untouched.
    expect(sessions[B].title).toBe("Renamed");
    const byLabel = Object.fromEntries(getUndoHistory().items.map((i) => [i.label, i.status]));
    expect(byLabel["Stashed “First”"]).toBe("undone");
    expect(byLabel["Renamed “Second” to “Renamed”"]).toBe("done");
  });
});
