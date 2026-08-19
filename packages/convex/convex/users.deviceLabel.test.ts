// The device chip read "darwin": the command-poll heartbeat sends device_id
// without device_label, and the upsert's `label: device_label ?? platform`
// fallback overwrote the real label ("macOS - <hostname>") with the platform
// string on every poll. The policy now only writes a label the daemon actually
// sent; the platform default applies to a brand-new row alone.
import { describe, expect, test } from "bun:test";
import { deviceLabelWrite } from "./users";

describe("deviceLabelWrite", () => {
  test("a sent label is written on patch and insert alike", () => {
    expect(deviceLabelWrite({ deviceLabel: "macOS - Ashots-MacBook", platform: "darwin", isNew: false }))
      .toEqual({ label: "macOS - Ashots-MacBook" });
    expect(deviceLabelWrite({ deviceLabel: "macOS - Ashots-MacBook", platform: "darwin", isNew: true }))
      .toEqual({ label: "macOS - Ashots-MacBook" });
  });

  test("a label-less beat leaves an existing label alone (no darwin clobber)", () => {
    expect(deviceLabelWrite({ deviceLabel: undefined, platform: "darwin", isNew: false })).toEqual({});
  });

  test("a blank label counts as absent, not as a label", () => {
    expect(deviceLabelWrite({ deviceLabel: "", platform: "darwin", isNew: false })).toEqual({});
  });

  test("a brand-new row falls back to the platform so the required field exists", () => {
    expect(deviceLabelWrite({ deviceLabel: undefined, platform: "darwin", isNew: true }))
      .toEqual({ label: "darwin" });
  });
});
