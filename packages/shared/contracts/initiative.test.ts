import { describe, expect, test } from "bun:test";
import { chainLine, initiativeChain, initiativeStanding, metricAgainst, metricKeyOf, metricLine, metricNumber, metricReaches, metricReading, metricReadings, type InitiativeRow } from "./initiative";
import { formatScheduledTask, parseScheduledTask, roleCardInitiativeLine, type RoleCard } from "./machineMessages";

const DAY = 86_400_000;

describe("a metric read against its target (I4)", () => {
  test("numbers as people write them", () => {
    expect(metricNumber("1,000")).toBe(1000);
    expect(metricNumber("$50k")).toBe(50_000);
    expect(metricNumber("2.5M")).toBe(2_500_000);
    expect(metricNumber("38%")).toBe(38);
    expect(metricNumber("at least 40")).toBe(40);
    expect(metricNumber("soon")).toBeNull();
    expect(metricNumber(null)).toBeNull();
  });

  test("on track means against the target, in the target's own direction", () => {
    const reach = { key: "wat", name: "Weekly active teams", target: "1,000" };
    expect(metricReading(reach, { value: "412", observed_at: 1, source: "ct-1" })).toMatchObject({ standing: "behind", progress: 0.412 });
    expect(metricReading(reach, { value: "1.2k", observed_at: 1, source: "ct-1" })).toMatchObject({ standing: "met", progress: 1 });
    expect(metricReading(reach)).toMatchObject({ value: null, standing: "unknown", progress: null });
    const under = { key: "churn", name: "Monthly churn", target: "under 5%" };
    expect(metricReading(under, { value: "3.1%", observed_at: 1, source: "ct-1" }).standing).toBe("met");
    expect(metricReading(under, { value: "7%", observed_at: 1, source: "ct-1" })).toMatchObject({ standing: "behind", progress: null });
    expect(metricReading({ key: "x", name: "Mood", target: "good" }, { value: "fine", observed_at: 1, source: "ct-1" }).standing).toBe("unknown");
  });

  test("the goal's standing: behind if any metric is, met only when every reported one is", () => {
    const now = Date.now();
    const row = { metrics: [{ key: "a", name: "A", target: "10" }, { key: "b", name: "B", target: "10" }], scoreboard: { a: { value: "12", observed_at: now, source: "ct-1" } } };
    expect(initiativeStanding(metricReadings(row))).toBe("unknown");
    expect(initiativeStanding(metricReadings({ ...row, scoreboard: { ...row.scoreboard, b: { value: "4", observed_at: now, source: "ct-1" } } }))).toBe("behind");
    expect(initiativeStanding(metricReadings({ ...row, scoreboard: { ...row.scoreboard, b: { value: "10", observed_at: now, source: "ct-1" } } }))).toBe("met");
    expect(initiativeStanding([])).toBe("unknown");
  });

  test("one line a role and a person both read", () => {
    const now = Date.now();
    const m = { key: "wat", name: "Weekly active teams", target: "1,000" };
    expect(metricLine(metricReading(m), now)).toBe("Weekly active teams: not reported yet, target 1,000");
    expect(metricLine(metricReading(m, { value: "412", observed_at: now - 3 * DAY, source: "ct-1" }), now)).toBe("Weekly active teams: 412 of 1,000, behind (3 days ago)");
    expect(metricLine(metricReading(m, { value: "1,100", observed_at: now, source: "ct-1" }), now)).toBe("Weekly active teams: 1,100 of 1,000, met (today)");
    // A number to stay under, and a target that is not a number, never read "of".
    const read = (target: string, value?: string) => metricReading({ key: "k", name: "K", target }, value === undefined ? null : { value, observed_at: now, source: "ct-1" });
    expect(metricAgainst(read("1,000", "412"))).toBe("412 of 1,000");
    expect(metricAgainst(read("under 20", "34"))).toBe("34, target under 20");
    expect(metricAgainst(read("< 5%", "7%"))).toBe("7%, target < 5%");
    // "<" followed by a space is still a number to stay under.
    expect([read("< 5%", "7%").standing, read("< 5%", "3%").standing, read("<= 5", "5").standing]).toEqual(["behind", "met", "met"]);
    expect(metricAgainst(read("at most 10", "4"))).toBe("4, target at most 10");
    expect(metricAgainst(read("shipped", "3"))).toBe("3, target shipped");
    expect(metricAgainst(read("under 20"))).toBe("target under 20");
    expect(metricLine(read("under 20", "34"), now)).toBe("K: 34, target under 20, behind (today)");
    expect([metricReaches("1,000"), metricReaches("at least 40"), metricReaches("under 20"), metricReaches("shipped")]).toEqual([true, true, false, false]);
  });

  test("a key is the name as a slug, the way a template scoreboard key reads", () => {
    expect(metricKeyOf("Weekly active teams")).toBe("weekly_active_teams");
    expect(metricKeyOf("  ARR ($)  ")).toBe("arr");
    expect(metricKeyOf("!!!")).toBe("");
  });
});

describe("the chain up to the top level goal", () => {
  const row = (id: string, title: string, parent?: string): Pick<InitiativeRow, "_id" | "short_id" | "title" | "parent_initiative_id"> => ({ _id: id, short_id: `in-${id}`, title, ...(parent ? { parent_initiative_id: parent } : {}) });
  const rows = [row("1", "Reach 1k teams"), row("2", "Win the private network", "1"), row("3", "Loop", "4"), row("4", "Loop back", "3")];
  const byId = (id: string) => rows.find((r) => r._id === id);
  test("nearest first, ending at the top, with a missing parent or a cycle ending the walk", () => {
    expect(initiativeChain(rows[1], byId)).toEqual([{ short_id: "in-1", title: "Reach 1k teams" }]);
    expect(initiativeChain(rows[0], byId)).toEqual([]);
    expect(initiativeChain(rows[2], byId)).toEqual([{ short_id: "in-4", title: "Loop back" }]);
    expect(initiativeChain(row("9", "Orphan", "nope"), byId)).toEqual([]);
    expect(chainLine([{ short_id: "in-1", title: "Reach 1k teams" }])).toBe("under Reach 1k teams");
    expect(chainLine([])).toBe("");
  });
});

describe("the role card carries what the area serves", () => {
  test("the frame writes and reads the initiatives with their chain and metric lines", () => {
    const role: RoleCard = {
      handle: "calling", name: "Calling lead", reports_to: "Ada", scope: ["Callers"], goals: ["Every broker answered in a day"],
      initiatives: [
        { short_id: "in-4", title: "Win the private network", chain: ["Reach 1k teams"], metrics: ["Weekly active teams: 412 of 1,000, behind (3 days ago)", "Brokers live: not reported yet, target 40"] },
        { short_id: "in-1", title: "Reach 1k teams", chain: [], metrics: [] },
      ],
    };
    const frame = formatScheduledTask({ title: "Check Callers", trigger: "tr-1", role, body: "Read your area." });
    expect(frame).toContain("Serves: Win the private network (in-4), under Reach 1k teams; Weekly active teams: 412 of 1,000, behind (3 days ago); Brokers live: not reported yet, target 40");
    expect(frame).toContain("Serves: Reach 1k teams (in-1)</role-card>");
    const back = parseScheduledTask(frame)!;
    expect(back.role?.initiatives).toEqual(role.initiatives);
    expect(back.body).toBe("Read your area.");
    expect(roleCardInitiativeLine(role.initiatives![1])).toBe("Reach 1k teams (in-1)");
  });

  test("a card from before the field reads with no initiatives", () => {
    const role: RoleCard = { handle: "docs", name: "Docs lead", reports_to: "Ada", scope: [], goals: [] };
    const back = parseScheduledTask(formatScheduledTask({ title: "t", role, body: "b" }))!;
    expect(back.role).toEqual(role);
  });
});
