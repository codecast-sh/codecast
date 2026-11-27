import { describe, expect, test } from "bun:test";
import { scribeShownStatus } from "../useScribe";

describe("scribeShownStatus", () => {
  test("with no press in flight, the server's status shows", () => {
    for (const s of ["absent", "joining", "listening"] as const) expect(scribeShownStatus(s, null)).toBe(s);
  });

  test("an invite on its way shows Scribe joining until the server says more", () => {
    expect(scribeShownStatus("absent", "invite")).toBe("joining");
    expect(scribeShownStatus("joining", "invite")).toBe("joining");
    expect(scribeShownStatus("listening", "invite")).toBe("listening");
  });

  test("a removal on its way shows Scribe gone", () => {
    expect(scribeShownStatus("listening", "remove")).toBe("absent");
    expect(scribeShownStatus("joining", "remove")).toBe("absent");
  });
});
