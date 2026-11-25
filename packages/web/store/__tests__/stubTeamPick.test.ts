import { afterEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// The new-session composer's Mine / Team pill (TeamPill) stamps the pick on
// the local stub (setStubTeam) and createSessionFromStub folds it into the
// create: Mine as `private`, Team as `team`, no pick as neither, so the folder
// rule decides on the server. A pick lost on this hop would start a session
// the person said was theirs as the team's, or the other way round.

const STUB = "stubteampick1";

afterEach(() => {
  const s = useInboxStore.getState();
  const sessions = { ...s.sessions };
  delete (sessions as any)[STUB];
  useInboxStore.setState({ sessions } as any);
});

function seedStub() {
  useInboxStore.setState({
    sessions: {
      ...useInboxStore.getState().sessions,
      [STUB]: { _id: STUB, session_id: STUB, updated_at: Date.now(), agent_type: "claude_code", project_path: "/tmp/proj", message_count: 0, is_idle: true, has_pending: false } as any,
    },
  } as any);
}

async function createOpts(): Promise<any> {
  const calls: any[] = [];
  const original = useInboxStore.getState().createSession;
  useInboxStore.setState({ createSession: (async (opts: any) => { calls.push(opts); return STUB; }) as any } as any);
  try {
    await useInboxStore.getState().createSessionFromStub(STUB);
  } finally {
    useInboxStore.setState({ createSession: original } as any);
  }
  return calls[0];
}

describe("the new-session Mine / Team pick", () => {
  it("no pick sends neither, so the folder rule decides", async () => {
    seedStub();
    const opts = await createOpts();
    expect(opts.private).toBeUndefined();
    expect(opts.team).toBeUndefined();
  });

  it("Team sends team; Personal sends nothing, so the folder rule still decides", async () => {
    seedStub();
    useInboxStore.getState().setStubTeam(STUB, "team");
    expect((useInboxStore.getState().sessions[STUB] as any)._team).toBe("team");
    expect(await createOpts()).toMatchObject({ team: true });

    useInboxStore.getState().setStubTeam(STUB, "mine");
    const opts = await createOpts();
    expect(opts.private).toBeUndefined();
    expect(opts.team).toBeUndefined();
  });
});
