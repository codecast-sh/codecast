import { describe, expect, test } from "bun:test";
import type { FlowMap } from "@codecast/shared/contracts/flowMap";
import { coverageRows, volumeBlocks, type VolumeLive } from "../volumeBlocks";

const NOW = Date.UTC(2026, 10, 11, 2, 30);
const today = new Date(NOW).toISOString().slice(0, 10);
const day = (o: Partial<{ arrived: number; read: number; judged: number; failed: number; waiting: number }>) => ({ day: today, arrived: 0, read: 0, judged: 0, failed: 0, waiting: 0, ...o });

const map = {
  header: { problemsOpen: 12_600, problemsScored: 0, decisionsForYou: 3, decisionsForTeam: 17, watching: 0, regressed: 0 },
  backlog: {
    at: NOW, total: 12_600, items: [], stations: [], days: [],
    stands: [{ stand: "nolead", n: 12_329 }, { stand: "noproject", n: 40 }, { stand: "stalled", n: 2 }],
    projects: [{ project: "p_aw", stand: "nolead", n: 12_329 }, { project: null, stand: "noproject", n: 40 }],
  },
  backlogProjects: { p_aw: { title: "AgentWatch", ref: "pj-mv49h7my" } },
  coverage: [
    { source_id: "s_m", kind: "conversation", label: "union-moments", provider: "ingest", days: [day({ arrived: 300, read: 300, judged: 280, failed: 13, waiting: 7 })] },
    { source_id: "s_p", kind: "recording", label: "union-posthog", provider: "posthog", days: [day({ arrived: 250, read: 40 })] },
  ],
} as unknown as FlowMap;

const live: VolumeLive = { on: true, hold: null, caps: { hands_per_day: 4 }, hands_today: 4, load: { working: 1, cap: 2 }, machines: { online: 1, total: 5 } };

describe("what holds work", () => {
  test("a project with no lead, the flow's caps and machines, decisions, stalled runs and unread sources, each with where to act", () => {
    const blocks = volumeBlocks(map, live, NOW, 7);
    const by = Object.fromEntries(blocks.map((b) => [b.key, b]));
    expect(by["nolead:p_aw"]).toMatchObject({ n: "12,329", label: "AgentWatch has no lead", act: { kind: "lead", project: "p_aw" } });
    expect(by.noproject.act).toEqual({ kind: "show", show: "stand:noproject" });
    expect(by.hands.n).toBe("4/4");
    expect(by.machines).toMatchObject({ n: "1/5", tone: "bad" });
    expect(by.slots).toBeUndefined();
    expect(by.decisions).toMatchObject({ n: "20", act: { kind: "go", patch: { view: "foryou" } } });
    expect(by.stalled.n).toBe("2");
    // Recordings with no judge: every one unread. Moments: the failed and the waiting.
    expect(by["src:s_p:recording"].n).toBe("250");
    expect(by["src:s_m:conversation"].n).toBe("20");
    // The flow's own blocks lead (they hold everything), then by count.
    expect(blocks[0].key === "hands" || blocks[0].key === "machines").toBe(true);
    expect(blocks.findIndex((b) => b.key === "nolead:p_aw")).toBeLessThan(blocks.findIndex((b) => b.key === "src:s_p:recording"));
  });

  test("a flow that is off or held says so first", () => {
    expect(volumeBlocks(map, { ...live, on: false }, NOW, 7)[0]).toMatchObject({ key: "off", act: { kind: "page" } });
    expect(volumeBlocks(map, { ...live, hold: { why: "deploy freeze", until: NOW + 1 } }, NOW, 7)[0]).toMatchObject({ key: "hold", label: "deploy freeze" });
  });

  test("a recording source's judged count comes from its replay moments", () => {
    const withReplay = { ...map, coverage: [...map.coverage!, { source_id: "s_p", kind: "replay", label: "union-posthog", provider: "posthog", days: [day({ arrived: 30, judged: 30 })] }] } as FlowMap;
    expect(coverageRows(withReplay, NOW, 7).find((r) => r.kind === "recording")).toMatchObject({ gap: 220, t: { judged: 30 } });
  });
});
