import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { LINE_PROFILE_DEFAULTS, lineProfileNotes, type PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { lineEditRows, lineEditStates, liveLineProfile } from "../../lib/lineSettings";

const s = () => useInboxStore.getState() as any;
const PID = "p".repeat(32);

const profile = (over: Partial<PublishedLineProfile> = {}): PublishedLineProfile => ({
  ...structuredClone(LINE_PROFILE_DEFAULTS),
  finders: [],
  root: "/repo",
  device_id: "dev-1",
  publisher_user_id: "u",
  sources: { size_budget: "default" },
  notes: lineProfileNotes(LINE_PROFILE_DEFAULTS),
  warnings: [],
  changed_at: 1,
  published_at: 1,
  ...over,
} as PublishedLineProfile);

let calls: Array<[string, unknown[]]> = [];
const owner = {};
beforeAll(() => s()._setDispatch(async (action: string, args: unknown[]) => { calls.push([action, args]); return { command_id: "c1" }; }, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  calls = [];
  useInboxStore.setState({ projects: { [PID]: { _id: PID, title: "P", line_profile: profile() } }, sessionCommands: {}, pending: {} } as any);
});

const rows = () => lineEditRows(s().sessionCommands, PID);
const echo = (requestId: string, over: Record<string, unknown>) =>
  s().syncTable("sessionCommands", [{ _id: requestId, command_id: "c1", command: "line_profile_edit", device_id: "dev-1", requested_at: 0, executed_at: null, result: null, error: null, ...over }], { isDelta: true });

describe("editLineProfile", () => {
  it("paints an edit row and never touches the project row", () => {
    s().editLineProfile("r1", PID, [{ op: "set", key: "size_budget", value: 250 }]);
    expect(s().projects[PID].line_profile.size_budget).toBe(400);
    expect(s().pending[`projects:${PID}:line_profile`]).toBeUndefined();
    expect(rows().map((r) => r.keys)).toEqual([["size_budget"]]);
    expect(calls[0]?.[0]).toBe("editLineProfile");
    expect(calls[0]?.[1]).toEqual(["r1", PID, [{ op: "set", key: "size_budget", value: 250 }]]);
  });

  it("shows the edit over the published copy until the republished copy arrives, through every push of the row", () => {
    s().editLineProfile("r1", PID, [{ op: "set", key: "size_budget", value: 250 }]);
    const t = Date.now();
    expect(liveLineProfile(s().projects[PID].line_profile, rows(), t).size_budget).toBe(250);
    // The daemon wrote the file and is republishing; the server echo keeps the local intent.
    echo("r1", { executed_at: t, result: JSON.stringify({ changed: true, published: { ok: "pending" } }) });
    expect(rows()[0].edits).toEqual([{ op: "set", key: "size_budget", value: 250 }]);
    expect(lineEditStates(rows(), s().projects[PID].line_profile, t).size_budget.state).toBe("publishing");
    expect(liveLineProfile(s().projects[PID].line_profile, rows(), t).size_budget).toBe(250);
    // The republished copy, stamped after the write, is the truth from here on.
    s().syncTable("projects", [{ _id: PID, title: "P", line_profile: profile({ size_budget: 250, sources: { size_budget: "file" }, published_at: t + 5 }) }], { isDelta: true });
    const lp = s().projects[PID].line_profile;
    expect(liveLineProfile(lp, rows(), t + 10)).toBe(lp);
    expect(lineEditStates(rows(), lp, t + 10).size_budget.state).toBe("saved");
  });

  it("a refused edit stops showing, and says why", () => {
    s().editLineProfile("r1", PID, [{ op: "set", key: "size_budget", value: 250 }]);
    echo("r1", { executed_at: Date.now(), error: "/repo/.codecast/line.toml: [line] size_budget must be a positive integer" });
    const lp = s().projects[PID].line_profile;
    expect(liveLineProfile(lp, rows(), Date.now())).toBe(lp);
    expect(lineEditStates(rows(), lp, Date.now()).size_budget).toMatchObject({ state: "refused", message: "[line] size_budget must be a positive integer" });
  });

  it("edits in flight on one project all stand, in the order they were made", () => {
    s().editLineProfile("r1", PID, [{ op: "set", key: "size_budget", value: 250 }]);
    s().editLineProfile("r2", PID, [{ op: "set", key: "watch_days", value: 3 }]);
    s().editLineProfile("r3", PID, [{ op: "set", key: "size_budget", value: 300 }]);
    const live = liveLineProfile(s().projects[PID].line_profile, rows(), Date.now());
    expect([live.size_budget, live.watch_days]).toEqual([300, 3]);
  });

  it("an edit nobody answers can be put back", () => {
    s().editLineProfile("r1", PID, [{ op: "set", key: "size_budget", value: 250 }]);
    const late = Date.now() + 60_000;
    const st = lineEditStates(rows(), s().projects[PID].line_profile, late).size_budget;
    expect(st).toMatchObject({ slow: true });
    s().dismissSessionCommand(st.requestId);
    expect(liveLineProfile(s().projects[PID].line_profile, rows(), late).size_budget).toBe(400);
  });
});
