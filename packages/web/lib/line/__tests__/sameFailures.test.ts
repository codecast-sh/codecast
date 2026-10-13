import { expect, test } from "bun:test";
import { sameFailures, serviceNames } from "../sameFailures";

// ct-59557 and Union's error log on 2026-10-13: the two AssemblyAI groups, and one that names no service.
const groups = [
  { _id: "a", short_id: "eg-511", kind: "error", title: "AssemblyAI session dead for contact track after 3 reconnects — transcription stopped for this track", count: 49, first_seen: 100, last_seen: 900 },
  { _id: "b", short_id: "eg-512", kind: "error", title: "AssemblyAI session dead for agent track after 3 reconnects — transcription stopped for this track", count: 49, first_seen: 120, last_seen: 950 },
  { _id: "c", short_id: "eg-486", kind: "error", title: "Electric live-replication probe threw: The operation timed out.", count: 302, first_seen: 1, last_seen: 2 },
];

test("a problem's title names its service; the groups that name it are the same failure, summed", () => {
  const title = "Live transcription and call tips down since Oct 12 04:53Z: AssemblyAI account out of funds";
  expect(serviceNames(title)).toEqual(["AssemblyAI"]);
  expect(sameFailures(title, groups)).toEqual({ name: "AssemblyAI", refs: ["eg-511", "eg-512"], count: 98, first: 100, last: 950 });
});

test("no service named, or none the log knows: nothing", () => {
  expect(sameFailures("Calls drop after the second ring", groups)).toBeNull();
  expect(sameFailures("PostHog events stopped", groups)).toBeNull();
});
