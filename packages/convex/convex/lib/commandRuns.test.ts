import { describe, expect, test } from "bun:test";
import { askToRun } from "@codecast/shared/contracts/commandRun";
import { resolveRunDevice } from "./commandRuns";

const host = { device_id: "h1", label: "i-0b91", last_seen: 50, is_remote: true, cloud_host: { managed_by: "mbp" } };
const mbp = { device_id: "mbp", label: "MacBook Pro", last_seen: 10 };
const mini = { device_id: "mini", label: "Mac mini", last_seen: 90 };

describe("resolveRunDevice", () => {
  test("no --on keeps the session's machine", () => {
    expect(resolveRunDevice([host, mbp], "h1", undefined)).toEqual({ device_id: "h1" });
  });

  test("laptop from a cloud host is the laptop managing it, not the one seen last", () => {
    expect(resolveRunDevice([host, mbp, mini], "h1", "laptop")).toEqual({ device_id: "mbp" });
  });

  test("laptop from a laptop session is that laptop", () => {
    expect(resolveRunDevice([host, mbp, mini], "mbp", "Laptop")).toEqual({ device_id: "mbp" });
  });

  test("laptop falls back to the laptop seen last when the manager is unknown", () => {
    expect(resolveRunDevice([{ ...host, cloud_host: null }, mbp, mini], "h1", "laptop")).toEqual({ device_id: "mini" });
    expect(resolveRunDevice([host], "h1", "laptop")).toMatchObject({ error: expect.stringContaining("no computer") });
  });

  test("a label, id or prefix names one machine; an ambiguous or unknown one is refused", () => {
    expect(resolveRunDevice([host, mbp, mini], "h1", "macbook")).toEqual({ device_id: "mbp" });
    expect(resolveRunDevice([host, mbp, mini], "h1", "mini")).toEqual({ device_id: "mini" });
    expect(resolveRunDevice([host, mbp, mini], "h1", "Mac")).toMatchObject({ error: expect.stringContaining("matches 2") });
    expect(resolveRunDevice([host, mbp, mini], "h1", "pixel")).toMatchObject({ error: expect.stringContaining("none of your machines") });
  });
});

test("askToRun is a cast decide --run line an agent can paste", () => {
  expect(askToRun("Let this host use your Chrome?", "cast browser extension link --host i-0b91", "laptop")).toBe(
    "cast decide 'Let this host use your Chrome?' --run 'cast browser extension link --host i-0b91' --on laptop",
  );
});
