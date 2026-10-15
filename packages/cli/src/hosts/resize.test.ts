import { expect, test } from "bun:test";
import { resizePlan } from "./resize";
import type { CloudHost } from "../browser/cloudHost";

const host: CloudHost = { id: "i-1", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "k", idleStopMinutes: 10 };
const prices = { "t3.medium": 0.0416, "t3.large": 0.0832, "t3.xlarge": 0.1664 };
const inst = (state: string, type = "t3.medium") => ({ InstanceType: type, State: { Name: state } });

test("an awake host's resize names the sizes, the monthly cost and the sessions it ends", () => {
  const plan = resizePlan(host, inst("running"), "t3.xlarge", prices, { sessions: 4, needBytes: 12 * 1024 ** 3 });
  expect(plan).toMatchObject({ from: "t3.medium", to: "t3.xlarge", awake: true });
  expect(plan.lines).toEqual([
    "t3.medium (4 GB, $0.0416/hour) → t3.xlarge (16 GB, $0.1664/hour)",
    "+$91/month if awake all month (it sleeps after 10 minutes idle, so it costs only the hours it is used)",
    "stops the host for about two minutes, ending the 4 agent sessions running on it, then starts it again",
  ]);
});

test("a size still below the repo's need says so; a sleeping host is not stopped", () => {
  const plan = resizePlan(host, inst("stopped"), "t3.large", prices, { needBytes: 12 * 1024 ** 3 });
  expect(plan.awake).toBe(false);
  expect(plan.lines.some((l) => l.startsWith("still too small for this repo: t3.large has 7.7 GB"))).toBe(true);
  expect(plan.lines.some((l) => l.includes("stops the host"))).toBe(false);
});

test("Macs, mid-transition hosts and non-Linux types are refused", () => {
  expect(() => resizePlan({ ...host, platform: "darwin" }, inst("running", "mac2.metal"), "mac2-m2.metal", prices)).toThrow("dedicated host");
  expect(() => resizePlan(host, inst("stopping"), "t3.large", prices)).toThrow("is stopping");
  expect(() => resizePlan(host, inst("running"), "mac2.metal", prices)).toThrow("not a Linux instance type");
});
