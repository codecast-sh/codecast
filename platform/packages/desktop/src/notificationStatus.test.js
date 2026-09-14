const { test, expect } = require("bun:test");
const { parseVerdict, statusFor, settingsUrl, readVerdict } = require("./notificationStatus");

const line = (app, as) =>
  JSON.stringify({
    eventMessage: `Presenting <NotificationRecord app:"${app}" ident:"1" uuid:"2"${as ? `> as ${as} (["badge", "sound", "alert"])` : ">"}`,
  });

test("reads this app's latest verdict and ignores every other app", () => {
  const log = [
    line("com.apple.ScriptEditor2", "banner"),
    line("email.whisk.desktop", "none"),
    line("com.tinyspeck.slackmacgap", "alert"),
    line("email.whisk.desktop", "banner"),
    line("com.apple.ScriptEditor2", "none"),
  ].join("\n");
  // The LAST verdict for us wins: an older one describes a setting since changed.
  expect(parseVerdict(log, "email.whisk.desktop")).toBe("banner");
  expect(parseVerdict(log, "com.apple.ScriptEditor2")).toBe("none");
  expect(parseVerdict(log, "sh.codecast.desktop")).toBeNull();
});

test("nothing to read, junk, or an unfamiliar verdict never reads as good news", () => {
  expect(parseVerdict("", "a.b")).toBeNull();
  expect(parseVerdict("not json\n{bad", "a.b")).toBeNull();
  expect(parseVerdict(line("a.b", ""), "a.b")).toBeNull();
  expect(parseVerdict(line("a.b", "somethingnew"), "a.b")).toBe("unknown");
});

test("the two shapes macOS draws on screen are the only ones that count as showing", () => {
  expect(statusFor("banner")).toBe("showing");
  expect(statusFor("alert")).toBe("showing");
  // "Allow Notifications" off and alert style "None" look identical from here.
  expect(statusFor("none")).toBe("silenced");
  expect(statusFor("unknown")).toBe("unknown");
  expect(statusFor(null)).toBe("unknown");
});

test("the settings link points at this app's own pane", () => {
  expect(settingsUrl("email.whisk.desktop")).toBe(
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=email.whisk.desktop",
  );
});

test("a log command that fails or hangs answers unknown, not granted", async () => {
  expect(await readVerdict("a.b", { exec: async () => null })).toBeNull();
  expect(await readVerdict("a.b", { exec: async () => line("a.b", "none") })).toBe("none");
  // The predicate asks usernoted for presentation lines only.
  let args;
  await readVerdict("a.b", { exec: async (_c, a) => { args = a; return ""; } });
  expect(args).toContain("--style");
  expect(args.join(" ")).toContain("usernoted");
});
