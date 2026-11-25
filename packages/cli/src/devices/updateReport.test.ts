import { describe, expect, test } from "bun:test";
import { explainUpdateError, isCurrent, notCurrent, settle, summaryLine, unsettled, verdictLine, type Verdict } from "./updateReport";

describe("isCurrent", () => {
  test("compares the running version to the release by number, not text", () => {
    expect(isCurrent("1.1.272", "1.1.273")).toBe(false);
    expect(isCurrent("1.1.273", "1.1.273")).toBe(true);
    expect(isCurrent("1.1.300", "1.1.273")).toBe(true);
    expect(isCurrent("1.1.99", "1.1.273")).toBe(false);
    expect(isCurrent("1.2.0", "1.1.273")).toBe(true);
    expect(isCurrent("2.0.0", "10.0.0")).toBe(false);
  });

  test("a machine that reports no version, or no release, is not current", () => {
    expect(isCurrent(undefined, "1.1.273")).toBe(false);
    expect(isCurrent("", "1.1.273")).toBe(false);
    expect(isCurrent("dev", "1.1.273")).toBe(false);
  });
});

describe("settle", () => {
  const at = 1000;
  test("the machine running the release is updated, whatever the row says", () => {
    expect(settle({ cli_version: "1.1.273", update_requested_at: at, update_state: "installing" }, "1.1.273", at)).toEqual({ kind: "updated" });
    expect(settle({ cli_version: "1.1.273" }, "1.1.273", at)).toEqual({ kind: "updated" });
  });

  test("its run failing for this request is a failure with the daemon's reason", () => {
    expect(settle({ cli_version: "1.1.272", update_requested_at: at, update_state: "failed", update_error: "checksum_mismatch_linux-x64" }, "1.1.273", at))
      .toEqual({ kind: "failed", reason: "the downloaded binary did not match the release checksum (checksum_mismatch_linux-x64)" });
  });

  test("still requested or installing: keep waiting", () => {
    expect(settle({ cli_version: "1.1.272", update_requested_at: at, update_state: "requested" }, "1.1.273", at)).toBeNull();
    expect(settle({ cli_version: "1.1.272", update_requested_at: at, update_state: "installing", online: false }, "1.1.273", at)).toBeNull();
    // A later press took the request over; its run still answers ours.
    expect(settle({ cli_version: "1.1.272", update_requested_at: at + 5, update_state: "requested" }, "1.1.273", at)).toBeNull();
  });

  test("a request cleared while the machine is still behind is a failure, never 'current'", () => {
    expect(settle({ cli_version: "1.1.272" }, "1.1.273", at)).toEqual({ kind: "failed", reason: "the request was cleared without an update; run it again" });
  });
});

describe("unsettled", () => {
  const now = 10 * 3600_000;
  test("offline names how long and that the request waits for it", () => {
    expect(unsettled({ online: false, last_seen: now - 3 * 3600_000 }, 300, now)).toEqual({ kind: "behind", reason: "offline (last seen 3h ago); asked, it updates when it is back" });
  });
  test("online says where the update stopped and how long it waited", () => {
    expect(unsettled({ online: true, update_state: "requested" }, 300, now).reason).toBe("has not started the update after 300s");
    expect(unsettled({ online: true, update_state: "installing" }, 300, now).reason).toBe("still installing after 300s");
    expect(unsettled({ online: true, update_state: "requested" }, 0, now).reason).toBe("asked; not waiting for it (--wait 0)");
  });
});

describe("explainUpdateError", () => {
  test.each([
    ["download_curl_22", "the download failed (curl exit 22) (download_curl_22)"],
    ["download_incomplete", "the download was cut short (download_incomplete)"],
    ["managed_install", "installed by your organization's MDM; it updates with the next Codecast.pkg (managed_install)"],
    ["platform_signature_wrong_team", "the new binary's code signature was refused (platform_signature_wrong_team)"],
    ["manifest_rollback_refused", "the release manifest could not be verified (manifest_rollback_refused)"],
    ["EACCES: permission denied, rename '/usr/local/bin/codecast'", "no permission to replace the binary (EACCES: permission denied, rename '/usr/local/bin/codecast')"],
    ["something new", "something new"],
  ])("%s", (code, words) => expect(explainUpdateError(code)).toBe(words));
  test("no code still says it failed", () => expect(explainUpdateError(undefined)).toBe("the update failed without a reason"));
});

describe("reporting", () => {
  const verdicts: Verdict[] = [
    { kind: "current" },
    { kind: "updated", from: "1.1.272" },
    { kind: "failed", reason: "x" },
    { kind: "behind", reason: "offline" },
    { kind: "skipped", reason: "inactive" },
  ];

  test("failed and behind machines fail the command; skipped ones do not count", () => {
    expect(verdicts.map(notCurrent)).toEqual([false, false, true, true, false]);
    expect(summaryLine(verdicts, "1.1.273")).toBe("2 of 4 on 1.1.273 or newer");
    expect(summaryLine([{ kind: "current" }, { kind: "skipped", reason: "x" }], "1.1.273")).toBe("1 of 1 on 1.1.273 or newer");
  });

  test("each line shows the version the machine runs and why", () => {
    expect(verdictLine({ kind: "updated", from: "1.1.272" }, "nose  ", "1.1.273")).toBe("updated     nose  1.1.272 → 1.1.273");
    expect(verdictLine({ kind: "current" }, "nose  ", "1.1.273")).toBe("current     nose  1.1.273");
    expect(verdictLine({ kind: "behind", reason: "offline" }, "nose  ", undefined)).toBe("not updated nose  unknown  offline");
  });
});
