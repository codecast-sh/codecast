// Editing a project update's body is a store action with an inverse, so ⌘Z
// right after it takes back that edit, not an older entry on the same page.
// Posts, comments and deletes paint at once and record nothing.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { _resetUndoStacks, getUndoHistory, performUndo } from "@platform/engine";
import { useInboxStore } from "../inboxStore";

const UPDATE = "k".repeat(32);
const PROJECT = "p".repeat(32);
const s = () => useInboxStore.getState() as any;
const owner = {};
const sent: Array<{ action: string; args: any[] }> = [];

beforeAll(() => s()._setDispatch(async (action: string, args: any[]) => { sent.push({ action, args }); return null; }, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  _resetUndoStacks();
  sent.length = 0;
  useInboxStore.setState({
    pending: {},
    currentUser: { _id: "u".repeat(32), name: "Ada" },
    projectUpdates: {
      [UPDATE]: { _id: UPDATE, project_id: PROJECT, author: "Ada", author_user_id: "u".repeat(32), author_kind: "user", kind: "update", body: "Shipped the parser", created_at: 1, comments: [] },
    },
  } as any);
});

test("an edit of an update's body paints at once and its undo sends the prior body", async () => {
  s().editProjectUpdate(UPDATE, "Shipped the parser and the printer");
  expect(s().projectUpdates[UPDATE].body).toBe("Shipped the parser and the printer");
  expect(getUndoHistory().items[0]?.label).toBe("Edited a project update");
  await new Promise((r) => setTimeout(r, 10));
  expect(sent.at(-1)).toMatchObject({ action: "editProjectUpdate", args: [UPDATE, "Shipped the parser and the printer"] });

  expect(performUndo()).toBe(true);
  expect(s().projectUpdates[UPDATE].body).toBe("Shipped the parser");
  await new Promise((r) => setTimeout(r, 10));
  expect(sent.some((c) => c.action === "editProjectUpdate" && c.args[1] === "Shipped the parser")).toBe(true);
});

test("a post, a comment and a delete paint at once and record no undo entry", () => {
  s().postProjectUpdate(PROJECT, { client_key: "pustub-1", body: "Weekly notes" });
  expect(s().projectUpdates["pustub-1"]).toMatchObject({ project_id: PROJECT, body: "Weekly notes", client_key: "pustub-1" });
  s().commentProjectUpdate(UPDATE, "Nice");
  expect(s().projectUpdates[UPDATE].comments.map((c: any) => c.text)).toEqual(["Nice"]);
  s().deleteProjectUpdate(UPDATE);
  expect(s().projectUpdates[UPDATE]).toBeUndefined();
  expect(getUndoHistory().items).toHaveLength(0);
});
