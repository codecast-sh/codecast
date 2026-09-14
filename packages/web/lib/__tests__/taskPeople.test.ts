import { test, expect, describe } from "bun:test";

// The task hover card and the shared object card both ask taskPeople who
// created a task and who holds it. The card once hid the creator when it was
// the viewer and the assignee when they had created the task, so a task the
// viewer filed for themselves showed nobody at all. Both are always reported.

const { useInboxStore } = await import("../../store/inboxStore");
const { taskPeople, taskProject } = await import("../entityDisplay");

const ME = { _id: "u_me", name: "Ashot", github_username: "ashot", image: "me.png" };
const ADA = { _id: "u_ada", name: "Ada", github_username: "ada", image: null };
const PROJECT = { _id: "p_1", title: "Agent Quality", status: "active" };

useInboxStore.setState({
  currentUser: ME,
  teamMembers: [ME, ADA],
  projects: { [PROJECT._id]: PROJECT },
} as any);

describe("taskPeople", () => {
  test("reports the creator even when the creator is the viewer", () => {
    const { creator, assignee } = taskPeople({ user_id: ME._id });
    expect(creator?.name).toBe("Ashot");
    expect(assignee).toBeNull();
  });

  test("reports the assignee even when they created the task, and says they are one person", () => {
    const { creator, assignee, samePerson } = taskPeople({ user_id: ME._id, assignee: ME._id });
    expect(creator?.name).toBe("Ashot");
    expect(assignee?.name).toBe("Ashot");
    expect(samePerson).toBe(true);
  });

  test("two different people are never folded into one", () => {
    expect(taskPeople({ user_id: ADA._id, assignee: ME._id }).samePerson).toBe(false);
    expect(taskPeople({ user_id: ME._id }).samePerson).toBe(false);
  });

  test("resolves a teammate from the roster", () => {
    const { creator, assignee } = taskPeople({ user_id: ADA._id, assignee: ME._id });
    expect(creator?.name).toBe("Ada");
    expect(assignee?.image).toBe("me.png");
  });

  test("falls back to the server's enrichment for someone off the roster", () => {
    const { creator } = taskPeople({ user_id: "u_gone", creator: { name: "Grace" } });
    expect(creator?.name).toBe("Grace");
  });
});

describe("taskProject", () => {
  test("names the project from the store", () => {
    expect(taskProject({ project_id: PROJECT._id })?.title).toBe("Agent Quality");
  });

  test("is null for an unfiled task or an uncached project", () => {
    expect(taskProject({})).toBeNull();
    expect(taskProject({ project_id: "p_missing" })).toBeNull();
  });
});
