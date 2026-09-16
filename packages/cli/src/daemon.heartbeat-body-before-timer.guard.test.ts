import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";

// Every POST to /cli/heartbeat feeds the backend outage clock. The request's
// abort timer must bound only the network round trip: when the body was built
// inside the fetch options (after AbortSignal.timeout had started), the awaits
// in it (ioreg, account files, sync backlog) ate the budget under load, the
// fetch aborted before it left, and self-heal restarted a healthy daemon every
// half hour (2026-09-15). The body is a prebuilt value; no await may sit
// between the timer and the fetch.
describe("heartbeat body is built before the abort timer starts", () => {
  const src = fs.readFileSync(path.join(import.meta.dir, "daemon.ts"), "utf8");
  const calls = [...src.matchAll(/fetch\(`\$\{siteUrl\}\/cli\/heartbeat`, \{/g)];

  test("every heartbeat post is found", () => {
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  test("no await inside the fetch options of a heartbeat post", () => {
    for (const call of calls) {
      const start = call.index!;
      const end = src.indexOf("});", start);
      const options = src.slice(start, end);
      expect(options).not.toContain("await ");
      expect(options).toContain("AbortSignal.timeout(");
    }
  });
});
