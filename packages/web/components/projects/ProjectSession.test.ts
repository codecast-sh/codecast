// A project's default session (session-projects.md SP4): the seated lead's
// standing session, else the canonical one.
// Run: bun test components/projects/ProjectSession.test.ts
import { describe, expect, test } from "bun:test";
import { projectDefaultSessionOf } from "./ProjectSession";
import type { InboxSession } from "../../store/inboxStore";

const row = (id: string, extra: Partial<InboxSession> = {}): InboxSession =>
  ({ _id: id.padEnd(32, "x"), session_id: id, title: id, updated_at: 1, message_count: 3, ...extra }) as InboxSession;

describe("projectDefaultSessionOf", () => {
  const project = { _id: "projA", owner_role_id: "role1", default_session_id: "canon".padEnd(32, "x") };

  test("the seated lead's standing session wins, from the org tree", () => {
    expect(projectDefaultSessionOf(project, {}, [{ _id: "role1", standing: { conversation_id: "seat" } }])).toBe("seat");
  });

  test("or from a loaded session that holds the lead's seat", () => {
    const seat = row("seat", { standing_role_id: "role1" } as any);
    expect(projectDefaultSessionOf(project, { [seat._id]: seat })).toBe(seat._id);
  });

  test("without a seated lead, the canonical session", () => {
    expect(projectDefaultSessionOf(project, {}, [{ _id: "role1", standing: null }])).toBe(project.default_session_id);
  });

  test("a stub the project's composer just started stands in until the server names it", () => {
    const stub = row("stub", { project_id: "projB", _projectDefault: true });
    expect(projectDefaultSessionOf({ _id: "projB" }, { [stub._id]: stub })).toBe(stub._id);
    expect(projectDefaultSessionOf({ _id: "projC" }, { [stub._id]: stub })).toBeNull();
  });
});
