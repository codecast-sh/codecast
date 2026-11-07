/**
 * Snapshot settling, driven by a fake page and a fake clock: which captures are
 * kept, how many are taken, and that every wait is bounded.
 */

import { describe, expect, test } from "bun:test";
import {
  captureSettled, judgeCapture, MAX_CAPTURES, parseSettleProbe, SETTLE_CAP_MS, SETTLE_PROBE_SOURCE, type SettleProbe,
} from "./snapshotSettle.js";

/** A page on a fake clock. `mutations` are page-relative times the DOM
 *  changed; `navigations` are clock times a new document started. */
function fakePage(opts: { mutations?: number[]; navigations?: number[]; captureMs?: number; clockInstalled?: boolean; mutateEvery?: number }) {
  let clock = 1000;
  let installed = opts.clockInstalled ?? true;
  const captures: number[] = [];
  const docStart = () => Math.max(0, ...(opts.navigations ?? []).filter((t) => t <= clock));
  const lastMutation = () => {
    if (opts.mutateEvery) return clock - (clock % opts.mutateEvery);
    const seen = (opts.mutations ?? []).filter((t) => t <= clock);
    return seen.length ? Math.max(...seen) : -1;
  };
  return {
    captures,
    elapsed: () => clock,
    deps: {
      now: () => clock,
      sleep: (ms: number) => {
        clock += ms;
      },
      capture: () => {
        captures.push(clock);
        clock += opts.captureMs ?? 40;
        return { status: 0, stdout: `capture@${captures.length}`, stderr: "" };
      },
      probe: (): SettleProbe => {
        clock += 5;
        const fresh = !installed;
        installed = true;
        const last = lastMutation();
        return {
          url: `https://a.test/${docStart()}`,
          sinceLoad: clock - docStart(),
          sinceMutation: fresh ? null : last < docStart() ? clock - docStart() : clock - last,
        };
      },
    },
  };
}

describe("judgeCapture", () => {
  test("a document younger than the capture navigated", () => {
    expect(judgeCapture({ url: "", sinceLoad: 30, sinceMutation: 30 }, 45)).toBe("navigated");
  });
  test("a mutation inside the capture window", () => {
    expect(judgeCapture({ url: "", sinceLoad: 9000, sinceMutation: 10 }, 45)).toBe("mutated");
  });
  test("an old mutation is stable", () => {
    expect(judgeCapture({ url: "", sinceLoad: 9000, sinceMutation: 400 }, 45)).toBe("stable");
  });
  test("a freshly installed clock cannot know", () => {
    expect(judgeCapture({ url: "", sinceLoad: 9000, sinceMutation: null }, 45)).toBe("unknown");
  });
});

describe("captureSettled", () => {
  test("a still page is captured once", () => {
    const page = fakePage({ mutations: [10] });
    const out = captureSettled(page.deps);
    expect(out.captures).toBe(1);
    expect(out.url).toBe("https://a.test/0");
  });

  test("a page mutating during capture waits for quiet and recaptures once", () => {
    const page = fakePage({ mutations: [1020, 1060, 1100] });
    const out = captureSettled(page.deps);
    expect(out.captures).toBe(2);
    expect(out.res.stdout).toBe("capture@2");
    // The second capture began after the last mutation had been quiet 55 ms.
    expect(page.captures[1]).toBeGreaterThanOrEqual(1100 + 55);
  });

  test("a page that never stops mutating is capped at 550 ms and one recapture", () => {
    const page = fakePage({ mutateEvery: 10 });
    const t0 = page.elapsed();
    const out = captureSettled(page.deps);
    expect(out.captures).toBe(2);
    expect(page.elapsed() - t0).toBeLessThan(SETTLE_CAP_MS + 200);
  });

  test("a navigation during capture recaptures on the new document", () => {
    const page = fakePage({ navigations: [1020] });
    const out = captureSettled(page.deps);
    expect(out.captures).toBe(2);
    expect(out.url).toBe("https://a.test/1020");
    expect(out.navigating).toBeUndefined();
  });

  test("a page that keeps navigating gives up after three captures and says so", () => {
    const page = fakePage({ navigations: [1020, 1160, 1300, 1450] });
    const out = captureSettled(page.deps);
    expect(out.captures).toBe(MAX_CAPTURES);
    expect(out.navigating).toBe(true);
  });

  test("a page whose clock was just installed gets one short look, no recapture when quiet", () => {
    const page = fakePage({ clockInstalled: false });
    const out = captureSettled(page.deps);
    expect(out.captures).toBe(1);
  });

  test("a page whose clock was just installed and is moving recaptures", () => {
    const page = fakePage({ clockInstalled: false, mutations: [1100] });
    const out = captureSettled(page.deps);
    expect(out.captures).toBe(2);
  });

  test("a failed capture or probe is returned as is", () => {
    const failed = captureSettled({ ...fakePage({}).deps, capture: () => ({ status: 1, stdout: "", stderr: "x" }) });
    expect(failed.res.status).toBe(1);
    const blind = captureSettled({ ...fakePage({}).deps, probe: () => null });
    expect(blind.url).toBeNull();
    expect(blind.captures).toBe(1);
  });
});

describe("the probe", () => {
  test("is one expression that evaluates to the probe JSON in a page-like global", () => {
    const g: any = { location: { href: "https://a.test/x" }, performance: { now: () => 500 }, document: {} };
    g.window = g;
    g.MutationObserver = class {
      observe() {}
    };
    const run = new Function("window", "location", "performance", "document", "MutationObserver", `return ${SETTLE_PROBE_SOURCE}`);
    const first = parseSettleProbe(JSON.stringify(run(g, g.location, g.performance, g.document, g.MutationObserver)));
    expect(first).toEqual({ url: "https://a.test/x", sinceLoad: 500, sinceMutation: null });
    const second = parseSettleProbe(JSON.stringify(run(g, g.location, g.performance, g.document, g.MutationObserver)));
    expect(second?.sinceMutation).toBe(500);
  });

  test("parses the engine's JSON envelope and bare output alike", () => {
    const inner = JSON.stringify({ url: "u", sinceLoad: 1, sinceMutation: 2 });
    expect(parseSettleProbe(JSON.stringify({ success: true, data: { result: inner } }))?.url).toBe("u");
    expect(parseSettleProbe(JSON.stringify(inner))?.sinceMutation).toBe(2);
    expect(parseSettleProbe("garbage")).toBeNull();
  });
});
