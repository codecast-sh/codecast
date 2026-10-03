import { expect, test } from "bun:test";
import { probeForExec } from "./operations";

test("the resource snapshot with executable names stays on the probe worker", () => {
  expect(probeForExec("ps", ["-eo", "pid=,ppid=,pcpu=,rss=,etime=,comm="], { timeout: 5000, killSignal: "SIGKILL" })).toMatchObject({ operation: "ps" });
  expect(probeForExec("ps", ["-eo", "pid=,ppid=,pcpu=,rss=,etime=,args="], { timeout: 5000 })).toBeNull();
});
