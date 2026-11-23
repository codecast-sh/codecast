// A session's people have one home: its inbox row once the server lists them
// there (owner_ids, which the card draws), else its sessionOwners row. A Save
// paints that home, so the card and the header show the same owners at once.
import { describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";

const ID = "jx7000000000000000000000000000own";
const owners = (ids: string[]) => ({
  _id: ID, short_id: "", conversation_id: ID, owner_ids: ids, role: null, runner: { user_id: "me", is_bot: false }, author_id: null, bots: [], can_edit: true,
  owners: ids.map((user_id, i) => ({ user_id, name: user_id, email: null, added_at: i + 1 })),
});

function seed(row: Record<string, unknown>, people: string[]) {
  useInboxStore.setState({
    currentUser: { _id: "me", name: "Me" },
    sessions: { [ID]: { _id: ID, session_id: "s-own", user_id: "me", updated_at: 1, ...row } },
    sessionOwners: { [ID]: owners(people) },
  } as any);
}

describe("applySessionOwners paints the people in their one home", () => {
  test("a listed session: the inbox row's owner_ids", () => {
    seed({ owner_ids: ["me"], owner_user_id: "me" }, ["me"]);
    useInboxStore.getState().applySessionOwners(ID, { add: ["mate"] });
    const s = useInboxStore.getState() as any;
    expect(s.sessions[ID].owner_ids).toEqual(["me", "mate"]);
    expect(s.sessionOwners[ID].owner_ids).toEqual(["me"]);
  });

  test("a row from an older server: the sessionOwners row", () => {
    seed({ owner_user_id: "me" }, ["me"]);
    useInboxStore.getState().applySessionOwners(ID, { add: ["mate"] });
    const s = useInboxStore.getState() as any;
    expect(s.sessions[ID].owner_ids).toBeUndefined();
    expect(s.sessionOwners[ID].owner_ids).toEqual(["me", "mate"]);
  });
});
