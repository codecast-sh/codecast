import { expect, test } from "bun:test";
import { isTaskStubId, taskCreateStub, taskStubId } from "../taskStub";

test("a create stub is keyed by its client key, carries it for the supersede, and takes the caller's fields over the defaults", () => {
  const stub = taskCreateStub("k1", { title: "Fix prove", status: "in_progress", category: "line" });
  expect(stub._id).toBe(taskStubId("k1"));
  expect(isTaskStubId(stub._id)).toBe(true);
  expect(isTaskStubId("jd7abc")).toBe(false);
  expect(stub).toMatchObject({ client_key: "k1", short_id: "ct-…", priority: "medium", status: "in_progress", title: "Fix prove", category: "line" });
  expect(stub.created_at).toBe(stub.updated_at);
});
