import { describe, expect, it } from "bun:test";
import { chipFilterOpts, chipMatchesSession, computeChipCounts, type InboxSession } from "../inboxStore";
import { projectChipLabel, workProjectChipKey, workProjectsBySession } from "../workProjects";

// Projects as an inbox filter (docs/architecture/session-projects.md): a
// session's project is derived from the store (own pick, bound task or plan,
// parent), projects get chips of their own on the folder chip axis, and a
// project chip matches the workers of a session put in it.

const row = (id: string, extra: Partial<InboxSession> = {}): InboxSession =>
  ({ _id: id.padEnd(32, "x"), session_id: id, updated_at: 1, project_path: "/Users/me/src/app", git_root: "/Users/me/src/app", ...extra }) as InboxSession;

const lead = row("lead", { project_id: "projA" });
const worker = row("worker", { parent_conversation_id: lead._id });
const spawned = row("spawned", { spawned_by_conversation_id: worker._id });
const taskBound = row("taskbound", { active_task: { _id: "t1" } as any });
const loose = row("loose", { project_path: "/Users/me/src/other", git_root: "/Users/me/src/other" });
const sessions = Object.fromEntries([lead, worker, spawned, taskBound, loose].map((s) => [s._id, s]));
const state = {
  sessions,
  tasks: { t1: { project_id: "projB" } } as any,
  plans: {} as any,
  activeProjectFilter: null as string | null,
  chipFilterExclude: false,
};

describe("workProjectsBySession", () => {
  it("derives each session's project from its pick, its task, or its parent chain", () => {
    const byId = workProjectsBySession(state);
    expect(byId.get(lead._id)).toBe("projA");
    expect(byId.get(worker._id)).toBe("projA");
    expect(byId.get(spawned._id)).toBe("projA");
    expect(byId.get(taskBound._id)).toBe("projB");
    expect(byId.get(loose._id)).toBeNull();
  });
});

describe("project chips", () => {
  it("count folders ahead of projects, each under its own key", () => {
    const { projectCounts } = computeChipCounts(Object.values(sessions), {}, (id) => workProjectsBySession(state).get(id) ?? null);
    expect(projectCounts).toEqual([
      ["app", 4],
      ["other", 1],
      [workProjectChipKey("projA"), 3],
      [workProjectChipKey("projB"), 1],
    ]);
  });

  it("a project chip shows the session put in it and its workers, a folder chip still shows its folder", () => {
    const visible = (filter: string, exclude = false) =>
      Object.values(sessions)
        .filter((s) => chipMatchesSession(s, chipFilterOpts({ ...state, activeProjectFilter: filter, chipFilterExclude: exclude }, {})))
        .map((s) => s.session_id);
    expect(visible(workProjectChipKey("projA"))).toEqual(["lead", "worker", "spawned"]);
    expect(visible("app")).toEqual(["lead", "worker", "spawned", "taskbound"]);
    expect(visible(workProjectChipKey("projA"), true)).toEqual(["taskbound", "loose"]);
  });

  it("label a project chip with the project's title and a folder chip with its name", () => {
    expect(projectChipLabel(workProjectChipKey("projA"), { projA: { title: "Mobile App" } })).toBe("Mobile App");
    expect(projectChipLabel("app", {})).toBe("app");
  });
});
