import { beforeEach, expect, test } from "bun:test";
import { newProjectHref, newProjectKeyOf, newProjectStartedBy, useInboxStore } from "../inboxStore";

const stub = "stub-np-1";
const real = "jx70000000000000000000000000np01";
const put = (id: string, row: Record<string, unknown>) =>
  useInboxStore.setState({ sessions: { [id]: { _id: id, session_id: id, ...row } as any } });

beforeEach(() => useInboxStore.setState({ sessions: {} }));

test("the stub's first send names its project, before and after the create files it", () => {
  put(stub, { _newProject: true });
  expect(newProjectStartedBy(stub)).toBe(newProjectKeyOf(stub));
  put(stub, { _newProject: true, project_id: newProjectKeyOf(stub), _projectDefault: true });
  expect(newProjectStartedBy(stub)).toBe(newProjectKeyOf(stub));
  expect(newProjectHref(newProjectKeyOf(stub))).toBe(`/projects/pjstub-${stub}`);
});

test("later sends from the rekeyed row, which still carries the flag, start nothing", () => {
  put(real, { _newProject: true, project_id: newProjectKeyOf(stub) });
  expect(newProjectStartedBy(real)).toBeNull();
  put(real, { _newProject: true, project_id: "jx7project0000000000000000000001" });
  expect(newProjectStartedBy(real)).toBeNull();
});

test("a session started inside an existing project, or without the switch, starts nothing", () => {
  put(stub, { project_id: "jx7project0000000000000000000001" });
  expect(newProjectStartedBy(stub)).toBeNull();
  put(stub, {});
  expect(newProjectStartedBy(stub)).toBeNull();
});
