import { expect, test } from "bun:test";
import { draftOf, metricsOfDraft } from "./metricsDraft";

test("an edit in the numbers editor keeps how a number is read (window, noise)", () => {
  const metrics = [
    { key: "intros_a_week", name: "Intros a week", target: "at least 60", series: "mw-14", window: "3w", noise: "poisson:1.75" },
    { key: "bounce", name: "Bounce", target: "under 3%", guardrail: true },
  ];
  expect(metricsOfDraft(draftOf(metrics))).toEqual(metrics);
  const renamed = draftOf(metrics).map((d, i) => (i === 0 ? { ...d, target: "at least 70" } : d));
  expect(metricsOfDraft(renamed)[0]).toEqual({ ...metrics[0], target: "at least 70" });
});
