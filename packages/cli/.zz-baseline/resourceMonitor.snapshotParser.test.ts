import { expect, test } from "bun:test";
import { parseProcessSnapshot } from "./resourceMonitor";
import { attributeProcesses } from "./systemResources";

test("process names with spaces retain attribution and never expose full executable paths", () => {
  const snapshot = parseProcessSnapshot(`
  101 1 150.5 1024 01:02 /private/work/bin/claude
  102 101 25.0 2048 00:03 /Applications/Browser.app/Helpers/Google Chrome Helper (Renderer)
  invalid process line
`, 100000);
  expect(snapshot.size).toBe(2);
  expect(snapshot.get(101)).toMatchObject({ cpu: 150.5, rss: 1048576, startedAt: 38000 });
  const rows = attributeProcesses(snapshot, new Map([["session", 101]]));
  expect(rows[1]).toMatchObject({ sessionId: "session", name: "Google Chrome Helper (Renderer)", kind: "browser", startedAt: 97000 });
  expect(JSON.stringify(rows)).not.toContain("/private/work");
  expect(JSON.stringify(rows)).not.toContain("/Applications");
});
