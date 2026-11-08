import { expect, test } from "bun:test";
import { stampSessionCommand } from "../sessionCommandStamp";

test("rewind steps of one conversation stand side by side, a repeat of a step replaces it, and none displaces a restart", () => {
  const draft = { sessionCommands: {} as Record<string, any> };
  stampSessionCommand(draft, { _id: "restart", conversation_id: "c", command: "resume_session", kind: "restart" });
  for (const op of ["plan", "diff", "stage", "put_back"]) stampSessionCommand(draft, { _id: op, conversation_id: "c", command: "rewind_files", kind: "rewind", op });
  expect(Object.keys(draft.sessionCommands).sort()).toEqual(["diff", "plan", "put_back", "restart", "stage"]);
  stampSessionCommand(draft, { _id: "plan2", conversation_id: "c", command: "rewind_files", kind: "rewind", op: "plan" });
  expect(Object.keys(draft.sessionCommands).sort()).toEqual(["diff", "plan2", "put_back", "restart", "stage"]);
  stampSessionCommand(draft, { _id: "restart2", conversation_id: "c", command: "resume_session", kind: "restart" });
  expect(draft.sessionCommands.restart).toBeUndefined();
  expect(draft.sessionCommands.stage).toBeDefined();
});
